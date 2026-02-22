const { Queue } = require('bullmq');
const { createRedisConnection, isRedisAvailable } = require('../config/redis');
const logger = require('../utils/logger');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                 EMAIL QUEUE (PRODUCER)                       ║
 * ║                                                              ║
 * ║  Enqueues email jobs for async processing by the worker.     ║
 * ║  Falls back to direct SMTP if Redis is unavailable.          ║
 * ║                                                              ║
 * ║  Job types: verification, welcome, passwordReset,            ║
 * ║             passwordChanged, accountLocked                   ║
 * ║                                                              ║
 * ║  Retry: 3 attempts with exponential backoff (2^n seconds).   ║
 * ║  Dead-letter: Failed jobs kept for 7 days for inspection.    ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const QUEUE_NAME = 'email';

let emailQueue = null;
let redisAvailable = false;

/**
 * Default job options: 3 retries, exponential backoff, 7-day retention.
 */
const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000, // 2s, 4s, 8s
  },
  removeOnComplete: {
    age: 86400,    // Keep completed jobs for 1 day (metrics)
    count: 1000,   // Keep at most 1000 completed
  },
  removeOnFail: {
    age: 604800,   // Keep failed jobs for 7 days (dead-letter inspection)
  },
};

/**
 * Initialize the email queue.
 * Call this during server startup.
 */
async function initEmailQueue() {
  try {
    redisAvailable = await isRedisAvailable();

    if (!redisAvailable) {
      logger.warn('Redis not available — email queue disabled, using direct SMTP fallback');
      return false;
    }

    emailQueue = new Queue(QUEUE_NAME, {
      connection: createRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });

    // Listen for queue-level errors
    emailQueue.on('error', (err) => {
      logger.error(`Email queue error: ${err.message}`);
    });

    logger.info('Email queue initialized (BullMQ + Redis)');
    return true;
  } catch (err) {
    logger.error(`Failed to initialize email queue: ${err.message}`);
    redisAvailable = false;
    return false;
  }
}

/**
 * Enqueue an email job.
 *
 * @param {string} type - Email type (e.g. 'verification', 'welcome')
 * @param {Object} data - Email data (recipient, template vars, etc.)
 * @param {Object} [opts] - Optional BullMQ job options override
 * @returns {boolean} true if queued, false if fallback required
 */
async function enqueueEmail(type, data, opts = {}) {
  if (!emailQueue || !redisAvailable) {
    return false; // Caller should use direct SMTP fallback
  }

  try {
    const jobName = `email:${type}`;
    await emailQueue.add(jobName, { type, ...data }, {
      ...DEFAULT_JOB_OPTS,
      ...opts,
    });
    logger.debug(`Email queued: ${jobName} → ${data.to || data.email}`);
    return true;
  } catch (err) {
    logger.error(`Failed to enqueue email (${type}): ${err.message}`);
    return false; // Caller should use direct SMTP fallback
  }
}

/**
 * Get queue health metrics for the health check endpoint.
 */
async function getQueueMetrics() {
  if (!emailQueue) {
    return { status: 'disabled', reason: 'Redis not available' };
  }

  try {
    const [waiting, active, completed, failed] = await Promise.all([
      emailQueue.getWaitingCount(),
      emailQueue.getActiveCount(),
      emailQueue.getCompletedCount(),
      emailQueue.getFailedCount(),
    ]);

    return {
      status: 'active',
      waiting,
      active,
      completed,
      failed,
    };
  } catch {
    return { status: 'error' };
  }
}

/**
 * Graceful shutdown — close the queue connection.
 */
async function closeEmailQueue() {
  if (emailQueue) {
    await emailQueue.close();
    emailQueue = null;
  }
}

/**
 * Check if queue-based email is available.
 */
function isQueueAvailable() {
  return redisAvailable && emailQueue !== null;
}

module.exports = {
  initEmailQueue,
  enqueueEmail,
  getQueueMetrics,
  closeEmailQueue,
  isQueueAvailable,
};
