const IORedis = require('ioredis');
const env = require('./env');
const logger = require('../utils/logger');

/**
 * Shared Redis connection for BullMQ queues and rate limiting.
 *
 * BullMQ requires ioredis. We expose a factory that creates connections
 * with sensible defaults so every consumer (queue, worker, rate-limiter)
 * gets its own connection as required by BullMQ's architecture.
 *
 * In environments without Redis (local dev, tests), callers should
 * degrade gracefully — the email service falls back to direct SMTP
 * and the rate limiter falls back to in-memory store.
 */

let _sharedConnection = null;
let _connectionFailed = false;

/**
 * Parse REDIS_URL into ioredis-compatible options.
 */
function getRedisOptions() {
  const opts = {
    maxRetriesPerRequest: null,   // Required by BullMQ
    enableReadyCheck: false,      // Required by BullMQ
    retryStrategy(times) {
      if (times > 10) return null; // Stop retrying after 10 attempts
      return Math.min(times * 200, 5000);
    },
    lazyConnect: true,
  };

  return { url: env.redis.url, opts };
}

/**
 * Create a new ioredis connection. Each BullMQ Queue and Worker
 * needs its own connection instance.
 */
function createRedisConnection() {
  const { url, opts } = getRedisOptions();
  const conn = new IORedis(url, opts);

  conn.on('error', (err) => {
    if (!_connectionFailed) {
      logger.error(`Redis connection error: ${err.message}`);
      _connectionFailed = true;
    }
  });

  conn.on('connect', () => {
    _connectionFailed = false;
    logger.info('Redis connected');
  });

  return conn;
}

/**
 * Get a shared connection (for rate-limiter and health checks).
 * Do NOT use this for BullMQ — BullMQ needs its own connections.
 */
function getSharedConnection() {
  if (!_sharedConnection) {
    _sharedConnection = createRedisConnection();
  }
  return _sharedConnection;
}

/**
 * Test Redis availability. Returns true if Redis is reachable.
 */
async function isRedisAvailable() {
  try {
    const conn = getSharedConnection();
    await conn.connect();
    const pong = await conn.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown — close the shared connection.
 */
async function closeRedis() {
  if (_sharedConnection) {
    await _sharedConnection.quit().catch(() => {});
    _sharedConnection = null;
  }
}

module.exports = {
  createRedisConnection,
  getSharedConnection,
  isRedisAvailable,
  closeRedis,
};
