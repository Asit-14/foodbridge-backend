const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const logger = require('../utils/logger');

// ── Redis store (lazy init) ────────────────────────
let redisStore = null;

/**
 * Initialize Redis store for rate limiting.
 * Call during server startup after Redis connection is confirmed.
 *
 * @param {import('ioredis').Redis} redisClient - Shared ioredis connection
 */
async function initRedisRateLimitStore(redisClient) {
  try {
    const { RedisStore } = require('rate-limit-redis');
    redisStore = new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
      prefix: 'rl:',
    });
    logger.info('Rate limiter using Redis store (multi-instance safe)');
  } catch (err) {
    logger.warn(`Rate limiter Redis store failed, using memory store: ${err.message}`);
    redisStore = null;
  }
}

// ── Custom key generator ───────────────────────────

/**
 * Generate rate limit key from IP address.
 * Uses req.ip which respects Express's trust proxy setting.
 */
function getClientIP(req) {
  return req.ip || req.socket?.remoteAddress || '0.0.0.0';
}

// ── RFC 7807 rate limit handler ────────────────────

function rateLimitHandler(req, res, _next, options) {
  const ip = getClientIP(req);
  logger.warn(`Rate limit exceeded: ${req.method} ${req.originalUrl} from ${ip}`);

  const retryAfter = Math.ceil(options.windowMs / 1000);

  res.status(options.statusCode).json({
    type: 'https://foodbridge.api/errors/rate-limit',
    title: 'Too Many Requests',
    status: options.statusCode,
    detail: options.message,
    instance: req.originalUrl,
    errorCode: 'RATE_LIMIT',
    requestId: req.id || 'unknown',
    retryAfter,
  });
}

function skipHealthCheck(req) {
  return req.path === '/api/health';
}

// ── Test environment override ─────────────────────
const isTest = env.isTest;
const TEST_MAX = 10000;

function getStore() {
  return redisStore || undefined;
}

// ── Rate Limiters ──────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs || 15 * 60 * 1000,
  max: isTest ? TEST_MAX : (env.rateLimit.max || 100),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  skip: skipHealthCheck,
  handler: rateLimitHandler,
  message: 'Too many requests, please try again later.',
  get store() { return getStore(); },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? TEST_MAX : 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: rateLimitHandler,
  message: 'Too many authentication attempts. Please try again in 15 minutes.',
  skipSuccessfulRequests: false,
  get store() { return getStore(); },
});

const strictAuthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isTest ? TEST_MAX : 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: rateLimitHandler,
  message: 'Too many requests. Please try again in an hour.',
  get store() { return getStore(); },
});

module.exports = {
  apiLimiter,
  authLimiter,
  strictAuthLimiter,
  getClientIP,
  initRedisRateLimitStore,
};
