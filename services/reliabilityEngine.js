const User = require('../models/User');
const PickupLog = require('../models/PickupLog');
const Donation = require('../models/Donation');
const logger = require('../utils/logger');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          NGO RELIABILITY ENGINE                             ║
 * ║                                                             ║
 * ║  Computes a composite reliability score (0–100) for each   ║
 * ║  NGO based on 5 behavioural metrics:                       ║
 * ║                                                             ║
 * ║    1. Delivery success rate (40%)                           ║
 * ║    2. Average pickup speed (20%)                            ║
 * ║    3. Cancellation rate — inverse (15%)                     ║
 * ║    4. Acceptance-to-pickup ratio (15%)                      ║
 * ║    5. Recency bonus (10%)                                   ║
 * ║                                                             ║
 * ║  Called nightly by cron job, or on-demand by admin.         ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

/**
 * Recalculate reliability scores for all active NGOs.
 * @returns {number}  Count of NGOs updated
 */
async function recalculateAllScores() {
  const ngos = await User.find({ role: 'ngo', isActive: true }, '_id');
  let updated = 0;

  for (const ngo of ngos) {
    try {
      const newScore = await recalculateScore(ngo._id);
      if (newScore !== null) updated++;
    } catch (err) {
      logger.error(`Reliability recalc failed for NGO ${ngo._id}: ${err.message}`);
    }
  }

  logger.info(`Reliability engine: recalculated ${updated}/${ngos.length} NGOs`);
  return updated;
}

/**
 * Recalculate reliability score for a single NGO.
 * @param {string} ngoId  Mongoose ObjectId
 * @returns {number|null}  New score, or null if no data
 */
async function recalculateScore(ngoId) {
  // ── Aggregate all performance metrics in one pipeline ──
  const [stats] = await PickupLog.aggregate([
    { $match: { ngoId: ngoId } },
    {
      $group: {
        _id: null,
        totalAccepted: { $sum: 1 },
        totalDelivered: {
          $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] },
        },
        totalPickedUp: {
          $sum: { $cond: [{ $eq: ['$status', 'picked_up'] }, 1, 0] },
        },
        totalFailed: {
          $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
        },
        // Average response time: accept → pickup in minutes
        avgPickupMins: {
          $avg: {
            $cond: [
              { $and: [{ $ne: ['$pickupTime', null] }, { $ne: ['$acceptedAt', null] }] },
              { $divide: [{ $subtract: ['$pickupTime', '$acceptedAt'] }, 60000] },
              null,
            ],
          },
        },
        // Most recent activity
        lastActivityAt: { $max: '$updatedAt' },
      },
    },
  ]);

  if (!stats || stats.totalAccepted === 0) {
    // New NGO with no history — set neutral score
    await User.findByIdAndUpdate(ngoId, { reliabilityScore: 50 });
    return null;
  }

  // ── Factor 1: Delivery success rate (0–100) — weight 40% ──
  const successRate = (stats.totalDelivered / stats.totalAccepted) * 100;

  // ── Factor 2: Pickup speed (0–100) — weight 20% ──
  let speedScore = 50;
  if (stats.avgPickupMins !== null) {
    if (stats.avgPickupMins <= 10) speedScore = 100;
    else if (stats.avgPickupMins <= 20) speedScore = 80;
    else if (stats.avgPickupMins <= 30) speedScore = 60;
    else if (stats.avgPickupMins <= 45) speedScore = 35;
    else speedScore = 10;
  }

  // ── Factor 3: Cancellation rate inverse (0–100) — weight 15% ──
  const cancelRate = stats.totalFailed / stats.totalAccepted;
  const cancelScore = Math.max(0, 100 - cancelRate * 200); // 50% fail = 0

  // ── Factor 4: Acceptance-to-pickup ratio (0–100) — weight 15% ──
  const pickupCompleteCount = stats.totalDelivered + stats.totalPickedUp;
  const completionRate = (pickupCompleteCount / stats.totalAccepted) * 100;
  const completionScore = Math.min(100, completionRate);

  // ── Factor 5: Recency bonus (0–100) — weight 10% ──
  // More recent activity = higher bonus (NGOs that are active recently)
  let recencyScore = 30;
  if (stats.lastActivityAt) {
    const daysSinceActive = (Date.now() - new Date(stats.lastActivityAt)) / 86400000;
    if (daysSinceActive <= 1) recencyScore = 100;
    else if (daysSinceActive <= 3) recencyScore = 80;
    else if (daysSinceActive <= 7) recencyScore = 60;
    else if (daysSinceActive <= 14) recencyScore = 40;
    else recencyScore = 15;
  }

  // ── Composite weighted score ──
  const composite = Math.round(
    0.40 * successRate +
    0.20 * speedScore +
    0.15 * cancelScore +
    0.15 * completionScore +
    0.10 * recencyScore
  );

  const finalScore = Math.max(0, Math.min(100, composite));

  // ── Persist to user document ──
  await User.findByIdAndUpdate(ngoId, { reliabilityScore: finalScore });

  logger.debug(
    `Reliability: NGO ${ngoId} → ${finalScore} ` +
    `(success=${Math.round(successRate)}, speed=${speedScore}, ` +
    `cancel=${Math.round(cancelScore)}, completion=${Math.round(completionScore)}, ` +
    `recency=${recencyScore})`
  );

  return finalScore;
}

/**
 * Get detailed reliability breakdown for an NGO (admin view).
 */
async function getReliabilityDetails(ngoId) {
  const [stats] = await PickupLog.aggregate([
    { $match: { ngoId: ngoId } },
    {
      $group: {
        _id: null,
        totalAccepted: { $sum: 1 },
        totalDelivered: {
          $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] },
        },
        totalFailed: {
          $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
        },
        avgPickupMins: {
          $avg: {
            $cond: [
              { $and: [{ $ne: ['$pickupTime', null] }, { $ne: ['$acceptedAt', null] }] },
              { $divide: [{ $subtract: ['$pickupTime', '$acceptedAt'] }, 60000] },
              null,
            ],
          },
        },
        totalBeneficiaries: { $sum: '$beneficiaryCount' },
        lastActivityAt: { $max: '$updatedAt' },
      },
    },
  ]);

  // Count reassignments (how many times this NGO was removed from a donation)
  const reassignCount = await Donation.countDocuments({
    'reassignHistory.ngoId': ngoId,
  });

  const user = await User.findById(ngoId, 'name organizationName reliabilityScore');

  return {
    ngo: user,
    currentScore: user?.reliabilityScore || 0,
    metrics: {
      totalAccepted: stats?.totalAccepted || 0,
      totalDelivered: stats?.totalDelivered || 0,
      totalFailed: stats?.totalFailed || 0,
      successRate: stats?.totalAccepted
        ? `${Math.round((stats.totalDelivered / stats.totalAccepted) * 100)}%`
        : 'N/A',
      avgPickupMins: stats?.avgPickupMins
        ? `${Math.round(stats.avgPickupMins)} min`
        : 'N/A',
      totalBeneficiaries: stats?.totalBeneficiaries || 0,
      reassignments: reassignCount,
      lastActive: stats?.lastActivityAt || null,
    },
  };
}

module.exports = { recalculateAllScores, recalculateScore, getReliabilityDetails };
