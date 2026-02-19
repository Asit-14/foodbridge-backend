const User = require('../models/User');
const Donation = require('../models/Donation');
const PickupLog = require('../models/PickupLog');
const logger = require('../utils/logger');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           INTELLIGENT MATCHING ENGINE v2.0                  ║
 * ║                                                             ║
 * ║  Multi-factor scoring with 7 weighted dimensions:           ║
 * ║    1. Proximity (geo distance, exponential decay)           ║
 * ║    2. Time urgency (expiry countdown)                       ║
 * ║    3. NGO reliability (composite score from profile)        ║
 * ║    4. Response time history (how fast NGO picks up)         ║
 * ║    5. Delivery success rate (historical %)                  ║
 * ║    6. Capacity match (quantity alignment)                   ║
 * ║    7. Time-of-day factor (rush-hour traffic penalty)        ║
 * ║                                                             ║
 * ║  Formula:                                                   ║
 * ║    score = W1×distance + W2×urgency + W3×reliability        ║
 * ║          + W4×responseTime + W5×successRate                 ║
 * ║          + W6×capacity + W7×timeOfDay                       ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const SEARCH_RADIUS_KM = 10;
const EARTH_RADIUS_KM = 6378.1;

// ── Tunable weights (sum to 1.0) ─────────────────────
const WEIGHTS = {
  distance:     0.25,
  urgency:      0.20,
  reliability:  0.15,
  responseTime: 0.15,
  successRate:  0.10,
  capacity:     0.10,
  timeOfDay:    0.05,
};

// ══════════════════════════════════════════════════════
//  COMPONENT SCORERS (each returns 0–100)
// ══════════════════════════════════════════════════════

/** Proximity: exponential decay — being close matters much more. */
function scoreDistance(distanceKm) {
  if (distanceKm >= SEARCH_RADIUS_KM) return 0;
  return Math.max(0, 100 * Math.exp(-2 * (distanceKm / SEARCH_RADIUS_KM)));
}

/** Time urgency: higher when expiry is imminent. */
function scoreUrgency(expiryTime) {
  const minsLeft = (new Date(expiryTime) - Date.now()) / 60000;
  if (minsLeft <= 0) return 0;
  if (minsLeft <= 15) return 100;
  if (minsLeft <= 30) return 95;
  if (minsLeft <= 60) return 80;
  if (minsLeft <= 120) return 55;
  if (minsLeft <= 240) return 35;
  return 15;
}

/** Reliability: directly from the user's composite score. */
function scoreReliability(raw) {
  return Math.min(100, Math.max(0, raw));
}

/**
 * Response time: how fast this NGO typically confirms after accepting.
 * @param {number|null} avgMins  Avg minutes from accept → actual pickup
 */
function scoreResponseTime(avgMins) {
  if (avgMins === null || avgMins === undefined) return 50;
  if (avgMins <= 10) return 100;
  if (avgMins <= 20) return 85;
  if (avgMins <= 30) return 65;
  if (avgMins <= 45) return 40;
  return 15;
}

/**
 * Historical delivery success rate.
 * @param {number} delivered  Completed pickups
 * @param {number} total      Total accepted
 */
function scoreSuccessRate(delivered, total) {
  if (total === 0) return 50;
  return Math.round((delivered / total) * 100);
}

/**
 * Capacity match: does this NGO handle donations of this size?
 * @param {number} qty       Donation quantity
 * @param {number} avgQty    NGO's historical average quantity
 * @param {number} maxQty    NGO's historical max quantity
 */
function scoreCapacity(qty, avgQty, maxQty) {
  if (!avgQty || !maxQty) return 50;
  if (qty > maxQty * 1.5) return 10;
  if (qty <= avgQty) return 100;
  const ratio = (qty - avgQty) / (maxQty - avgQty + 1);
  return Math.round(Math.max(20, 100 - ratio * 80));
}

/**
 * Time-of-day heuristic: penalize during peak traffic hours.
 * In production, swap with a real traffic API.
 */
function scoreTimeOfDay() {
  const hour = new Date().getHours();
  if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20)) return 40;
  if (hour >= 23 || hour <= 5) return 30;
  return 90;
}

// ══════════════════════════════════════════════════════
//  MAIN MATCHING FUNCTION
// ══════════════════════════════════════════════════════

/**
 * Find and rank NGOs for a donation using all 7 scoring factors.
 *
 * @param {string} donationId  Mongoose ObjectId
 * @returns {Array<Object>}    Sorted best-first with factor breakdown
 */
async function findBestNGO(donationId) {
  const donation = await Donation.findById(donationId);
  if (!donation) throw new Error('Donation not found');
  if (donation.status !== 'Available') return [];

  const [lng, lat] = donation.location.coordinates;

  // ── 1. Geo-query: NGOs within radius ───────────
  const nearbyNGOs = await User.find({
    role: 'ngo',
    isActive: true,
    isVerified: true,
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: SEARCH_RADIUS_KM * 1000,
      },
    },
  }).limit(30);

  if (nearbyNGOs.length === 0) return [];

  // ── 2. Exclude previously-failed NGOs ──────────
  const declinedIds = new Set(
    donation.reassignHistory.map((h) => h.ngoId.toString())
  );

  const eligibleNGOs = nearbyNGOs.filter((n) => !declinedIds.has(n._id.toString()));
  const ngoIds = eligibleNGOs.map((n) => n._id);
  if (ngoIds.length === 0) return [];

  // ── 3. Batch-fetch performance data ────────────
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [ngoStats, todayLoad] = await Promise.all([
    PickupLog.aggregate([
      { $match: { ngoId: { $in: ngoIds } } },
      {
        $group: {
          _id: '$ngoId',
          totalAccepted: { $sum: 1 },
          totalDelivered: {
            $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] },
          },
          totalFailed: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
          },
          avgResponseMins: {
            $avg: {
              $cond: [
                { $and: [{ $ne: ['$pickupTime', null] }, { $ne: ['$acceptedAt', null] }] },
                { $divide: [{ $subtract: ['$pickupTime', '$acceptedAt'] }, 60000] },
                null,
              ],
            },
          },
          avgQuantity: { $avg: '$beneficiaryCount' },
          maxQuantity: { $max: '$beneficiaryCount' },
        },
      },
    ]),
    PickupLog.aggregate([
      {
        $match: {
          createdAt: { $gte: todayStart },
          ngoId: { $in: ngoIds },
          status: { $in: ['in_progress', 'picked_up', 'delivered'] },
        },
      },
      { $group: { _id: '$ngoId', count: { $sum: 1 } } },
    ]),
  ]);

  const statsMap = new Map(ngoStats.map((s) => [s._id.toString(), s]));
  const loadMap = new Map(todayLoad.map((p) => [p._id.toString(), p.count]));

  // ── 4. Score each NGO ──────────────────────────
  const todScore = scoreTimeOfDay();
  const scored = [];

  for (const ngo of eligibleNGOs) {
    const ngoIdStr = ngo._id.toString();

    const dailyCount = loadMap.get(ngoIdStr) || 0;
    if (dailyCount >= 10) continue;

    // Haversine distance
    const dLat = ((ngo.location.coordinates[1] - lat) * Math.PI) / 180;
    const dLng = ((ngo.location.coordinates[0] - lng) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat * Math.PI) / 180) *
        Math.cos((ngo.location.coordinates[1] * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    const distanceKm = EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (distanceKm > SEARCH_RADIUS_KM) continue;

    const stats = statsMap.get(ngoIdStr) || {};

    const factors = {
      distance:     scoreDistance(distanceKm),
      urgency:      scoreUrgency(donation.expiryTime),
      reliability:  scoreReliability(ngo.reliabilityScore),
      responseTime: scoreResponseTime(stats.avgResponseMins),
      successRate:  scoreSuccessRate(stats.totalDelivered || 0, stats.totalAccepted || 0),
      capacity:     scoreCapacity(donation.quantity, stats.avgQuantity, stats.maxQuantity),
      timeOfDay:    todScore,
    };

    const finalScore =
      WEIGHTS.distance     * factors.distance +
      WEIGHTS.urgency      * factors.urgency +
      WEIGHTS.reliability  * factors.reliability +
      WEIGHTS.responseTime * factors.responseTime +
      WEIGHTS.successRate  * factors.successRate +
      WEIGHTS.capacity     * factors.capacity +
      WEIGHTS.timeOfDay    * factors.timeOfDay;

    scored.push({
      ngoId: ngo._id,
      name: ngo.name,
      organizationName: ngo.organizationName,
      distanceKm: Math.round(distanceKm * 100) / 100,
      score: Math.round(finalScore * 100) / 100,
      factors,
      dailyLoad: dailyCount,
      historicalDeliveries: stats.totalDelivered || 0,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  logger.info(
    `Matching v2: donation ${donationId} → ${scored.length} candidates ` +
    `(top: ${scored[0]?.score || 'none'}, NGO: ${scored[0]?.name || 'none'})`
  );

  return scored;
}

module.exports = { findBestNGO, WEIGHTS, SEARCH_RADIUS_KM };
