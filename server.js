const http = require('http');
const app = require('./app');
const connectDB = require('./config/db');
const env = require('./config/env');
const logger = require('./utils/logger');
const initSocket = require('./socket');
const { startAll: startCron, stopAll: stopCron } = require('./services/cronService');

// ── Create HTTP server (needed for Socket.io) ──────
const server = http.createServer(app);

// ── Boot sequence ──────────────────────────────────
async function start() {
  // 1. Connect to MongoDB
  await connectDB();

  // 2. Initialize Socket.io
  initSocket(server);

  // 3. Start cron jobs (after DB is ready)
  startCron();

  // 4. Start listening
  server.listen(env.port, () => {
    logger.info(
      `Server running in ${env.nodeEnv} mode on port ${env.port}`
    );
  });

  // 5. Request timeout (2 minutes)
  server.setTimeout(120000);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
}

start().catch((err) => {
  logger.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});

app.get("/", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "FoodBridge Backend API is running 🚀"
  });
});

// ── Graceful shutdown ──────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received. Shutting down gracefully...`);

  // Stop cron jobs first (prevent new DB writes during shutdown)
  stopCron();

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
