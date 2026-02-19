const cron = require('node-cron');
const Donation = require('../models/Donation');
const User = require('../models/User');
const PickupLog = require('../models/PickupLog');
const { findBestNGO } = require('./matchingService');
const { notify, broadcast } = require('./notificationService');
const { recalculateAllScores } = require('./reliabilityEngine');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════════
//  JOB REGISTRY — tracks state for health/status endpoint
// ═══════════════════════════════════════════════════════

const jobs = {};

/**
 * Register a cron job with state tracking.
 * Jobs are registered in "stopped" state — call startAll() to begin.
 */
function registerJob(name, schedule, handler) {
  const task = cron.schedule(schedule, async () => {
    const start = Date.now();
    jobs[name].lastRunAt = new Date();
    jobs[name].status = 'running';
    jobs[name].runCount += 1;

    try {
      const result = await handler();
      jobs[name].status = 'idle';
      jobs[name].lastDurationMs = Date.now() - start;
      jobs[name].lastError = null;
      jobs[name].lastResult = result ?? null;
    } catch (err) {
      jobs[name].status = 'error';
      jobs[name].lastDurationMs = Date.now() - start;
      jobs[name].lastError = err.message;
      logger.error(`Cron [${name}] failed (${Date.now() - start}ms): ${err.message}`);
    }
  }, { scheduled: false });

  jobs[name] = {
    schedule,
    status: 'idle',
    lastRunAt: null,
    lastDurationMs: null,
    lastError: null,
    lastResult: null,
    runCount: 0,
    task,
  };
}

// ═══════════════════════════════════════════════════════
//  JOB A — Auto-expire donations (every 1 minute)
// ═══════════════════════════════════════════════════════

registerJob('expire-donations', '* * * * *', async () => {
  const now = new Date();
  const result = await Donation.updateMany(
    { status: 'Available', expiryTime: { $lte: now } },
    { status: 'Expired' }
  );

  if (result.modifiedCount > 0) {
    logger.info(`Cron [expire-donations]: marked ${result.modifiedCount} donation(s) as Expired`);
  }
  return { expired: result.modifiedCount };
});

// ═══════════════════════════════════════════════════════
//  JOB B — Auto-reassign stale accepted donations (every 5 minutes)
//
//  If a donation is "Accepted" but the NGO hasn't picked up
//  within 20 minutes: penalize NGO, log failure, then either
//  re-match (up to 3 times) or expire.
// ═══════════════════════════════════════════════════════

registerJob('reassign-stale', '*/5 * * * *', async () => {
  const cutoff = new Date(Date.now() - 20 * 60 * 1000);
  const stale = await Donation.find({
    status: 'Accepted',
    acceptedAt: { $lte: cutoff },
  });

  if (stale.length === 0) return { reassigned: 0, expired: 0 };

  let reassigned = 0;
  let expired = 0;

  for (const donation of stale) {
    try {
      if (donation.acceptedBy) {
        // Penalize delinquent NGO (-5 reliability)
        await User.findByIdAndUpdate(donation.acceptedBy, {
          $inc: { reliabilityScore: -5 },
        });

        // Mark pickup log as failed
        await PickupLog.findOneAndUpdate(
          { donationId: donation._id, ngoId: donation.acceptedBy, status: 'in_progress' },
          { status: 'failed', failureReason: 'No pickup within 20-minute window' }
        );

        // Notify delinquent NGO
        await notify({
          recipientId: donation.acceptedBy.toString(),
          type: 'donation_reassigned',
          title: 'Pickup Timeout',
          message: `You didn't pick up "${donation.foodType}" in time. It's been reassigned.`,
          data: { donationId: donation._id },
        });

        // Record in reassign history
        donation.reassignHistory.push({
          ngoId: donation.acceptedBy,
          acceptedAt: donation.acceptedAt,
          expiredAt: new Date(),
          reason: 'No pickup within 20 minutes',
        });
      }

      donation.reassignCount += 1;

      if (donation.reassignCount >= 3) {
        // Max reassigns reached — expire the donation
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
          donationId: donation._id,
          status: 'Expired',
          reason: 'max_reassigns',
        });

        expired++;
        logger.info(`Cron [reassign-stale]: donation ${donation._id} expired (3 reassigns)`);
      } else {
        // Reset to Available and re-match
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
          _id: donation._id,
          foodType: donation.foodType,
          quantity: donation.quantity,
          expiryTime: donation.expiryTime,
          reassigned: true,
          reassignCount: donation.reassignCount,
        });

        // Proactively notify best match
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

        reassigned++;
        logger.info(
          `Cron [reassign-stale]: donation ${donation._id} → Available (attempt ${donation.reassignCount})`
        );
      }
    } catch (err) {
      logger.error(`Cron [reassign-stale]: failed for donation ${donation._id}: ${err.message}`);
    }
  }

  return { reassigned, expired };
});

// ═══════════════════════════════════════════════════════
//  JOB C — Daily NGO reliability recalculation (midnight)
//
//  Uses the reliability engine which scores NGOs on:
//    - Delivery success rate (40%)
//    - Average pickup speed (20%)
//    - Cancellation frequency (15%)
//    - Acceptance-to-pickup ratio (15%)
//    - Recency bonus (10%)
// ═══════════════════════════════════════════════════════

registerJob('reliability-recalc', '0 0 * * *', async () => {
  const count = await recalculateAllScores();
  logger.info(`Cron [reliability-recalc]: updated ${count} NGO scores`);
  return { ngosUpdated: count };
});

// ═══════════════════════════════════════════════════════
//  JOB D — Clean expired password-reset & email-verification
//          tokens (every hour)
//
//  Removes token values from User documents where the
//  expiry date has passed. This is a data-hygiene task —
//  the tokens are already invalid (queries check expiry),
//  but clearing them reduces document size and avoids
//  stale data in DB snapshots.
// ═══════════════════════════════════════════════════════

registerJob('clean-expired-tokens', '0 * * * *', async () => {
  const now = new Date();

  // Clear expired password reset tokens
  const resetResult = await User.updateMany(
    {
      passwordResetExpires: { $lt: now },
      passwordResetToken: { $ne: null },
    },
    {
      $unset: { passwordResetToken: 1, passwordResetExpires: 1 },
    }
  );

  // Clear expired email verification tokens
  const verifyResult = await User.updateMany(
    {
      emailVerificationExpires: { $lt: now },
      emailVerificationToken: { $ne: null },
      isEmailVerified: false,
    },
    {
      $unset: { emailVerificationToken: 1, emailVerificationExpires: 1 },
    }
  );

  const total = resetResult.modifiedCount + verifyResult.modifiedCount;
  if (total > 0) {
    logger.info(
      `Cron [clean-expired-tokens]: cleared ${resetResult.modifiedCount} reset + ${verifyResult.modifiedCount} verification tokens`
    );
  }
  return {
    resetTokensCleared: resetResult.modifiedCount,
    verificationTokensCleared: verifyResult.modifiedCount,
  };
});

// ═══════════════════════════════════════════════════════
//  LIFECYCLE — start / stop / status
// ═══════════════════════════════════════════════════════

/**
 * Start all registered cron jobs.
 * Call this after DB connection is established.
 */
function startAll() {
  for (const [name, job] of Object.entries(jobs)) {
    job.task.start();
    logger.info(`Cron [${name}]: started (${job.schedule})`);
  }
  logger.info(`Cron service: ${Object.keys(jobs).length} jobs running`);
}

/**
 * Gracefully stop all cron jobs.
 * Call this during server shutdown.
 */
function stopAll() {
  for (const [name, job] of Object.entries(jobs)) {
    job.task.stop();
    job.status = 'stopped';
  }
  logger.info('Cron service: all jobs stopped');
}

/**
 * Return status of all jobs (for the /health endpoint).
 */
function getStatus() {
  const result = {};
  for (const [name, job] of Object.entries(jobs)) {
    result[name] = {
      schedule: job.schedule,
      status: job.status,
      lastRunAt: job.lastRunAt,
      lastDurationMs: job.lastDurationMs,
      lastError: job.lastError,
      lastResult: job.lastResult,
      runCount: job.runCount,
    };
  }
  return result;
}

module.exports = { startAll, stopAll, getStatus };
