const cron = require('node-cron');
const Donation = require('../models/Donation');
const User = require('../models/User');
const PickupLog = require('../models/PickupLog');
const { findBestNGO } = require('../services/matchingService');
const { notify, broadcast } = require('../services/notificationService');
const { recalculateAllScores } = require('../services/reliabilityEngine');
const logger = require('../utils/logger');

/**
 * Register all background cron jobs.
 */
function registerJobs() {
  // ══════════════════════════════════════════════════
  //  1. EXPIRY CHECKER — every 5 minutes
  // ══════════════════════════════════════════════════
  cron.schedule('*/5 * * * *', async () => {
    try {
      const now = new Date();
      const expired = await Donation.updateMany(
        { status: 'Available', expiryTime: { $lte: now } },
        { status: 'Expired' }
      );
      if (expired.modifiedCount > 0) {
        logger.info(`Expiry job: marked ${expired.modifiedCount} donations as Expired`);
      }
    } catch (err) {
      logger.error(`Expiry job failed: ${err.message}`);
    }
  });

  // ══════════════════════════════════════════════════
  //  2. SMART REASSIGNMENT — every 5 minutes
  //     Catches donations accepted > 20 min ago with no pickup.
  //     Penalizes the NGO, marks pickup log as failed,
  //     then either re-matches or expires after 3 failures.
  // ══════════════════════════════════════════════════
  cron.schedule('*/5 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 20 * 60 * 1000);
      const stale = await Donation.find({
        status: 'Accepted',
        acceptedAt: { $lte: cutoff },
      });

      for (const donation of stale) {
        if (donation.acceptedBy) {
          // Penalize delinquent NGO
          await User.findByIdAndUpdate(donation.acceptedBy, {
            $inc: { reliabilityScore: -5 },
          });

          // Mark pickup log as failed
          await PickupLog.findOneAndUpdate(
            { donationId: donation._id, ngoId: donation.acceptedBy, status: 'in_progress' },
            { status: 'failed', failureReason: 'No pickup within 20-minute window' }
          );

          // Notify the delinquent NGO
          await notify({
            recipientId: donation.acceptedBy.toString(),
            type: 'donation_reassigned',
            title: 'Pickup Timeout',
            message: `You didn't pick up "${donation.foodType}" in time. It's been reassigned.`,
            data: { donationId: donation._id },
          });

          donation.reassignHistory.push({
            ngoId: donation.acceptedBy,
            acceptedAt: donation.acceptedAt,
            expiredAt: new Date(),
            reason: 'No pickup within 20 minutes',
          });
        }

        donation.reassignCount += 1;

        if (donation.reassignCount >= 3) {
          donation.status = 'Expired';
          await donation.save();

          await notify({
            recipientId: donation.donorId.toString(),
            type: 'donation_expired',
            title: 'Donation Expired',
            message: `"${donation.foodType}" expired after 3 failed pickup attempts.`,
            data: { donationId: donation._id },
          });

          broadcast(`donation:${donation._id}`, 'donation-status-update', {
            donationId: donation._id, status: 'Expired', reason: 'max_reassigns',
          });

          logger.info(`Reassign: donation ${donation._id} expired (3 reassigns)`);
        } else {
          donation.status = 'Available';
          donation.acceptedBy = null;
          donation.acceptedAt = null;
          await donation.save();

          await notify({
            recipientId: donation.donorId.toString(),
            type: 'donation_reassigned',
            title: 'Finding New NGO',
            message: `"${donation.foodType}" is being matched to another NGO (attempt ${donation.reassignCount}/3).`,
            data: { donationId: donation._id },
          });

          broadcast('role:ngo', 'new-donation', {
            _id: donation._id, foodType: donation.foodType,
            quantity: donation.quantity, expiryTime: donation.expiryTime,
            reassigned: true, reassignCount: donation.reassignCount,
          });

          const matches = await findBestNGO(donation._id);
          if (matches.length > 0) {
            await notify({
              recipientId: matches[0].ngoId.toString(),
              type: 'new_donation_nearby',
              title: 'Urgent: Reassigned Donation',
              message: `${donation.foodType} (${donation.quantity} ${donation.unit}) — ${matches[0].distanceKm}km away`,
              data: { donationId: donation._id },
            });
          }

          logger.info(`Reassign: donation ${donation._id} → Available (attempt ${donation.reassignCount})`);
        }
      }
    } catch (err) {
      logger.error(`Reassign job failed: ${err.message}`);
    }
  });

  // ══════════════════════════════════════════════════
  //  3. NGO RELIABILITY RECALCULATION — daily at 2 AM
  // ══════════════════════════════════════════════════
  cron.schedule('0 2 * * *', async () => {
    try {
      const count = await recalculateAllScores();
      logger.info(`Reliability recalc: updated ${count} NGOs`);
    } catch (err) {
      logger.error(`Reliability recalc failed: ${err.message}`);
    }
  });

  logger.info('Background jobs registered (expiry, reassign, reliability)');
}

module.exports = registerJobs;
