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
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── Custom key generator ───────────────────────────

/**
 * Generate rate limit key from IP address
 * Handles proxied requests (X-Forwarded-For)
 */
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection.remoteAddress;
}

/**
 * Generate key combining IP and user ID (if available)
 * Provides per-user rate limiting for authenticated requests
 */
function getUserKey(req) {
  const ip = getClientIP(req);
  const userId = req.user?._id?.toString() || 'anonymous';
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

// ── Rate Limiters ──────────────────────────────────

/**
 * General API rate limiter
 * Applies to all API endpoints
 */
const apiLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs || 15 * 60 * 1000, // 15 minutes
  max: env.rateLimit.max || 100, // 100 requests per window
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
  keyGenerator: getClientIP,
  skip: skipHealthCheck,
  handler: rateLimitHandler,
  message: 'Too many requests, please try again later.',
});

/**
 * Standard auth limiter
 * For login, token refresh
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // 15 attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: rateLimitHandler,
  message: 'Too many authentication attempts. Please try again in 15 minutes.',
  skipSuccessfulRequests: false,
});

/**
 * Strict auth limiter
 * For registration, email verification
 * Very strict to prevent abuse
 */
const strictAuthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: rateLimitHandler,
  message: 'Too many requests. Please try again in an hour.',
});

/**
 * Password reset limiter
 * Prevents email enumeration and abuse
 */
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: rateLimitHandler,
  message: 'Too many password reset attempts. Please try again later.',
});

/**
 * Email sending limiter
 * Prevents email spam
 */
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 emails per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: rateLimitHandler,
  message: 'Too many email requests. Please try again later.',
});

/**
 * Upload limiter
 * For file upload endpoints
 */
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 uploads per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getUserKey,
  handler: rateLimitHandler,
  message: 'Too many uploads. Please try again later.',
});

/**
 * Sensitive operation limiter
 * For delete operations, admin actions
 */
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getUserKey,
  handler: rateLimitHandler,
  message: 'Rate limit exceeded for sensitive operations.',
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
    ...options,
  });
}

/**
 * Sliding window rate limiter using memory store
 * More accurate but uses more memory
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
    // Note: For production with multiple instances,
    // use Redis store instead of memory store
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
};
