const http = require('http');
const app = require('./app');
const connectDB = require('./config/db');
const env = require('./config/env');
const logger = require('./utils/logger');
const initSocket = require('./socket');
const { startAll: startCron, stopAll: stopCron } = require('./services/cronService');
const { isRedisAvailable, getSharedConnection, closeRedis } = require('./config/redis');
const { initEmailQueue, closeEmailQueue } = require('./queues/emailQueue');
const { startEmailWorker, stopEmailWorker } = require('./workers/emailWorker');
const { sendEmail } = require('./services/emailService');
const { initRedisRateLimitStore } = require('./middleware/rateLimiter');

// ── Create HTTP server (needed for Socket.io) ──────
const server = http.createServer(app);

// ── Boot sequence ──────────────────────────────────
async function start() {
  // 1. Connect to MongoDB
  await connectDB();

  // 2. Initialize Redis (non-blocking — server works without it)
  const redisUp = await isRedisAvailable();
  if (redisUp) {
    // 2a. Initialize email queue + worker
    const queueReady = await initEmailQueue();
    if (queueReady) {
      startEmailWorker(sendEmail);
    }

    // 2b. Upgrade rate limiter to Redis store
    const redisClient = getSharedConnection();
    await initRedisRateLimitStore(redisClient);
  } else {
    logger.warn('Redis not available — running with in-memory rate limits and direct SMTP');
  }

  // 3. Initialize Socket.io
  initSocket(server);

  // 4. Start cron jobs (after DB is ready)
  startCron();

  // 5. Start listening
  server.listen(env.port, () => {
    logger.info(
      `Server running in ${env.nodeEnv} mode on port ${env.port}`
    );
  });

  // 6. Request timeout (2 minutes)
  server.setTimeout(120000);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
}

start().catch((err) => {
  logger.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────
async function shutdown(signal) {
  logger.info(`${signal} received. Shutting down gracefully...`);

  // Stop cron jobs first (prevent new DB writes during shutdown)
  stopCron();

  // Stop email worker (finish in-progress jobs, stop accepting new ones)
  await stopEmailWorker().catch(() => {});

  // Close email queue connection
  await closeEmailQueue().catch(() => {});

  // Close Redis
  await closeRedis().catch(() => {});

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled Rejection: ${err.message}`);
  shutdown('unhandledRejection');
});
