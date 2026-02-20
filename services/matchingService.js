const User = require('../models/User');
const Donation = require('../models/Donation');
const PickupLog = require('../models/PickupLog');
const logger = require('../utils/logger');
const { getStateCitySlugs, getNearbyCitySlugs } = require('../data/indiaLocations');
const { STATUS, SEARCH_RADIUS_KM, EXPANDED_RADIUS_KM, MAX_DAILY_PICKUPS } = require('../utils/constants');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           INTELLIGENT MATCHING ENGINE v3.0                  ║
 * ║                                                             ║
 * ║  Multi-level city-aware matching with 7 scored dimensions:  ║
 * ║                                                             ║
 * ║  MATCHING HIERARCHY:                                        ║
 * ║    Step 1: Match NGOs in SAME CITY (citySlug)               ║
 * ║    Step 2: Sort by distance within city                     ║
 * ║    Step 3: Apply 7-factor scoring formula                   ║
 * ║    Step 4: If none found → expand to SAME STATE cities      ║
 * ║    Step 5: If still none → fallback to RADIUS-BASED         ║
 * ║                                                             ║
 * ║  SCORING FACTORS:                                           ║
 * ║    1. Proximity (geo distance, exponential decay)           ║
 * ║    2. Time urgency (expiry countdown)                       ║
 * ║    3. NGO reliability (composite score from profile)        ║
 * ║    4. Response time history (how fast NGO picks up)         ║
 * ║    5. Delivery success rate (historical %)                  ║
 * ║    6. Capacity match (quantity alignment)                   ║
 * ║    7. Time-of-day factor (rush-hour traffic penalty)        ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

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
function scoreDistance(distanceKm, maxRadius) {
  if (distanceKm >= maxRadius) return 0;
  return Math.max(0, 100 * Math.exp(-2 * (distanceKm / maxRadius)));
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
 */
function scoreTimeOfDay() {
  const hour = new Date().getHours();
  if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20)) return 40;
  if (hour >= 23 || hour <= 5) return 30;
  return 90;
}

// ══════════════════════════════════════════════════════
//  HAVERSINE DISTANCE
// ══════════════════════════════════════════════════════

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ══════════════════════════════════════════════════════
//  PERFORMANCE DATA FETCHER
// ══════════════════════════════════════════════════════

async function fetchNGOPerformance(ngoIds) {
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

  return { statsMap, loadMap };
}

// ══════════════════════════════════════════════════════
//  SCORE NGOs AGAINST A DONATION
// ══════════════════════════════════════════════════════

function scoreNGOs(ngos, donation, statsMap, loadMap, maxRadius, matchLevel) {
  const [lng, lat] = donation.location.coordinates;
  const todScore = scoreTimeOfDay();
  const scored = [];

  for (const ngo of ngos) {
    const ngoIdStr = ngo._id.toString();

    // Skip overloaded NGOs
    const dailyCount = loadMap.get(ngoIdStr) || 0;
    if (dailyCount >= MAX_DAILY_PICKUPS) continue;

    // Haversine distance
    const distanceKm = haversineKm(
      lat, lng,
      ngo.location.coordinates[1], ngo.location.coordinates[0]
    );
    if (distanceKm > maxRadius) continue;

    const stats = statsMap.get(ngoIdStr) || {};

    const factors = {
      distance:     scoreDistance(distanceKm, maxRadius),
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
      city: ngo.city || null,
      state: ngo.state || null,
      distanceKm: Math.round(distanceKm * 100) / 100,
      score: Math.round(finalScore * 100) / 100,
      factors,
      dailyLoad: dailyCount,
      historicalDeliveries: stats.totalDelivered || 0,
      matchLevel, // 'city', 'state', or 'radius'
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ══════════════════════════════════════════════════════
//  MAIN MATCHING FUNCTION (v3 — city-aware)
// ══════════════════════════════════════════════════════

/**
 * Find and rank NGOs for a donation using multi-level city matching.
 *
 * Step 1: Same city (citySlug match)
 * Step 2: Nearby cities in same state
 * Step 3: Radius-based fallback (original behavior)
 *
 * @param {string} donationId  Mongoose ObjectId
 * @returns {Array<Object>}    Sorted best-first with factor breakdown
 */
async function findBestNGO(donationId) {
  const donation = await Donation.findById(donationId);
  if (!donation) throw new Error('Donation not found');
  if (donation.status !== STATUS.AVAILABLE) return [];

  const [lng, lat] = donation.location.coordinates;

  // Excluded NGOs (already failed)
  const declinedIds = new Set(
    donation.reassignHistory.map((h) => h.ngoId.toString())
  );

  const baseFilter = {
    role: 'ngo',
    isActive: true,
    isVerified: true,
    _id: { $nin: Array.from(declinedIds).map((id) => require('mongoose').Types.ObjectId.createFromHexString(id)) },
  };

  // ─────────────────────────────────────────────────
  // STEP 1: Same city matching (indexed citySlug query)
  // ─────────────────────────────────────────────────
  let results = [];

  if (donation.citySlug) {
    const cityNGOs = await User.find({
      ...baseFilter,
      citySlug: donation.citySlug,
    }).limit(30);

    if (cityNGOs.length > 0) {
      const ngoIds = cityNGOs.map((n) => n._id);
      const { statsMap, loadMap } = await fetchNGOPerformance(ngoIds);
      results = scoreNGOs(cityNGOs, donation, statsMap, loadMap, SEARCH_RADIUS_KM, 'city');

      if (results.length > 0) {
        logger.info(
          `Matching v3 [CITY]: donation ${donationId} → ${results.length} candidates in ${donation.city} ` +
          `(top: ${results[0]?.score}, NGO: ${results[0]?.name})`
        );
        return results;
      }
    }
  }

  // ─────────────────────────────────────────────────
  // STEP 2: Expand to other cities in same state
  // ─────────────────────────────────────────────────
  if (donation.stateCode) {
    const stateNGOs = await User.find({
      ...baseFilter,
      stateCode: donation.stateCode,
      ...(donation.citySlug ? { citySlug: { $ne: donation.citySlug } } : {}),
    }).limit(30);

    if (stateNGOs.length > 0) {
      const ngoIds = stateNGOs.map((n) => n._id);
      const { statsMap, loadMap } = await fetchNGOPerformance(ngoIds);
      results = scoreNGOs(stateNGOs, donation, statsMap, loadMap, EXPANDED_RADIUS_KM, 'state');

      if (results.length > 0) {
        logger.info(
          `Matching v3 [STATE]: donation ${donationId} → ${results.length} candidates in ${donation.state} ` +
          `(top: ${results[0]?.score}, NGO: ${results[0]?.name})`
        );
        return results;
      }
    }
  }

  // ─────────────────────────────────────────────────
  // STEP 3: Fallback to radius-based geo-query
  // ─────────────────────────────────────────────────
  const nearbyNGOs = await User.find({
    ...baseFilter,
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: SEARCH_RADIUS_KM * 1000,
      },
    },
  }).limit(30);

  if (nearbyNGOs.length === 0) {
    logger.info(`Matching v3 [RADIUS]: donation ${donationId} → 0 candidates within ${SEARCH_RADIUS_KM}km`);
    return [];
  }

  const ngoIds = nearbyNGOs.map((n) => n._id);
  const { statsMap, loadMap } = await fetchNGOPerformance(ngoIds);
  results = scoreNGOs(nearbyNGOs, donation, statsMap, loadMap, SEARCH_RADIUS_KM, 'radius');

  logger.info(
    `Matching v3 [RADIUS]: donation ${donationId} → ${results.length} candidates ` +
    `(top: ${results[0]?.score || 'none'}, NGO: ${results[0]?.name || 'none'})`
  );

  return results;
}

module.exports = { findBestNGO, WEIGHTS, SEARCH_RADIUS_KM, EXPANDED_RADIUS_KM };
