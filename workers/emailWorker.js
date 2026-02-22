const { Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const logger = require('../utils/logger');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                 EMAIL WORKER (CONSUMER)                      ║
 * ║                                                              ║
 * ║  Processes email jobs from the BullMQ queue using the        ║
 * ║  pooled SMTP transporter.                                    ║
 * ║                                                              ║
 * ║  Concurrency: 5 (processes 5 emails simultaneously)          ║
 * ║  Limiter: max 20 emails per 10 seconds (SMTP rate limit)     ║
 * ║                                                              ║
 * ║  Each job type maps to a handler that calls the email        ║
 * ║  service's sendEmail function with the appropriate template. ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const QUEUE_NAME = 'email';

let emailWorker = null;

/**
 * Email job handlers — one per email type.
 * Each handler receives the job data and calls the email service directly.
 * Add new handlers here as needed (e.g. donation_accepted, otp, delivery_confirmed).
 */
const handlers = {};

/**
 * Start the email worker.
 * Must be called after Redis is confirmed available.
 *
 * @param {Function} sendEmailFn - The sendEmail function from emailService
 */
function startEmailWorker(sendEmailFn) {
  if (emailWorker) {
    logger.warn('Email worker already running');
    return emailWorker;
  }

  emailWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { type, ...data } = job.data;
      const handler = handlers[type];

      if (!handler) {
        throw new Error(`Unknown email type: ${type}`);
      }

      const start = Date.now();
      const result = await handler(data, sendEmailFn);
      const elapsed = Date.now() - start;

      if (!result) {
        throw new Error(`Email send returned false for ${type} → ${data.to}`);
      }

      logger.info(`Email delivered: ${type} → ${data.to} (${elapsed}ms)`);
      return { delivered: true, elapsed };
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
      limiter: {
        max: 20,
        duration: 10000, // 20 emails per 10 seconds
      },
    }
  );

  emailWorker.on('completed', (job) => {
    logger.debug(`Email job ${job.id} completed`);
  });

  emailWorker.on('failed', (job, err) => {
    logger.error(`Email job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}`);
  });

  emailWorker.on('error', (err) => {
    logger.error(`Email worker error: ${err.message}`);
  });

  logger.info('Email worker started (concurrency=5, rate=20/10s)');
  return emailWorker;
}

/**
 * Graceful shutdown — close the worker.
 */
async function stopEmailWorker() {
  if (emailWorker) {
    await emailWorker.close();
    emailWorker = null;
    logger.info('Email worker stopped');
  }
}

module.exports = { startEmailWorker, stopEmailWorker };
