const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                  RATE LIMITING MIDDLEWARE                    ║
 * ║                                                              ║
 * ║  Multiple rate limiters for different endpoint types:        ║
 * ║  - API: General rate limit for all endpoints                 ║
 * ║  - Auth: Standard auth operations (login, refresh)           ║
 * ║  - Strict Auth: Registration, sensitive operations           ║
 * ║  - Password Reset: Prevents email enumeration                ║
 * ║  - Upload: File upload endpoints                             ║
 * ║                                                              ║
 * ║  Uses Redis store when available for multi-instance support. ║
 * ║  Falls back to in-memory store if Redis is unavailable.      ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

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
 * Uses req.ip which respects Express's trust proxy setting, so it
 * correctly identifies the real client IP behind reverse proxies.
 * NEVER parse X-Forwarded-For manually — it's spoofable.
 */
function getClientIP(req) {
  return req.ip || req.socket?.remoteAddress || '0.0.0.0';
}

/**
 * Generate key combining IP and user ID (if available)
 * Provides per-user rate limiting for authenticated requests
 */
function getUserKey(req) {
  const ip = getClientIP(req);
  const userId = req.user?._id?.toString() || 'anon';
  return `${ip}:${userId}`;
}

// ── Rate limit handlers ────────────────────────────

/**
 * Handler called when rate limit is exceeded
 */
function rateLimitHandler(req, res, _next, options) {
  const ip = getClientIP(req);
  logger.warn(`Rate limit exceeded: ${req.method} ${req.originalUrl} from ${ip}`);

  res.status(options.statusCode).json({
    status: 'fail',
    message: options.message,
    retryAfter: Math.ceil(options.windowMs / 1000),
  });
}

/**
 * Skip rate limiting for certain conditions
 */
function skipHealthCheck(req) {
  // Skip rate limiting for health checks
  return req.path === '/api/health';
}

// ── Test environment override ─────────────────────
// In test mode, rate limits are raised so integration tests run unimpeded.
const isTest = env.isTest;
const TEST_MAX = 10000; // effectively unlimited

/**
 * Helper to get the store option.
 * Returns Redis store if available, undefined otherwise (uses default memory).
 */
function getStore() {
  return redisStore || undefined;
}

// ── Rate Limiters ──────────────────────────────────

/**
 * General API rate limiter
 * Applies to all API endpoints
 */
const apiLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs || 15 * 60 * 1000, // 15 minutes
  max: isTest ? TEST_MAX : (env.rateLimit.max || 100),
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
  keyGenerator: getClientIP,
  skip: skipHealthCheck,
  handler: rateLimitHandler,
  message: 'Too many requests, please try again later.',
  get store() { return getStore(); },
});

/**
 * Standard auth limiter
 * For login, token refresh
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? TEST_MAX : 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: rateLimitHandler,
  message: 'Too many authentication attempts. Please try again in 15 minutes.',
  skipSuccessfulRequests: false,
  get store() { return getStore(); },
});

/**
 * Strict auth limiter
 * For registration, email verification
 * Very strict to prevent abuse
 */
const strictAuthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isTest ? TEST_MAX : 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: rateLimitHandler,
  message: 'Too many requests. Please try again in an hour.',
  get store() { return getStore(); },
});

/**
 * Password reset limiter
 * Prevents email enumeration and abuse
 */
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isTest ? TEST_MAX : 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: rateLimitHandler,
  message: 'Too many password reset attempts. Please try again later.',
  get store() { return getStore(); },
});

/**
 * Email sending limiter
 * Prevents email spam
 */
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isTest ? TEST_MAX : 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: rateLimitHandler,
  message: 'Too many email requests. Please try again later.',
  get store() { return getStore(); },
});

/**
 * Upload limiter
 * For file upload endpoints
 */
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isTest ? TEST_MAX : 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getUserKey,
  handler: rateLimitHandler,
  message: 'Too many uploads. Please try again later.',
  get store() { return getStore(); },
});

/**
 * Sensitive operation limiter
 * For delete operations, admin actions
 */
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isTest ? TEST_MAX : 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getUserKey,
  handler: rateLimitHandler,
  message: 'Rate limit exceeded for sensitive operations.',
  get store() { return getStore(); },
});

/**
 * Create custom rate limiter with specific options
 * @param {Object} options - Rate limit options
 * @returns {Function} Rate limit middleware
 */
function createLimiter(options) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: options.keyGenerator || getClientIP,
    handler: rateLimitHandler,
    store: getStore(),
    ...options,
  });
}

/**
 * Sliding window rate limiter
 * Use for critical endpoints only
 */
const slidingWindowLimiter = (windowMs, max) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getClientIP,
    handler: rateLimitHandler,
    store: getStore(),
  });

module.exports = {
  apiLimiter,
  authLimiter,
  strictAuthLimiter,
  passwordResetLimiter,
  emailLimiter,
  uploadLimiter,
  sensitiveLimiter,
  createLimiter,
  slidingWindowLimiter,
  getClientIP,
  getUserKey,
  initRedisRateLimitStore,
};
