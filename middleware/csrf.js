const crypto = require('crypto');
const AppError = require('../utils/AppError');
const env = require('../config/env');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                  CSRF PROTECTION MIDDLEWARE                   ║
 * ║                                                              ║
 * ║  Double-submit cookie pattern:                                ║
 * ║  1. Server sets a CSRF token as a non-httpOnly cookie         ║
 * ║  2. Client reads cookie and sends it in X-CSRF-Token header   ║
 * ║  3. Server validates header matches cookie                    ║
 * ║                                                              ║
 * ║  This works because a cross-site attacker cannot read         ║
 * ║  cookies from a different domain (same-origin policy).        ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const CSRF_COOKIE_NAME = 'csrf-token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_TOKEN_LENGTH = 32; // 32 bytes = 64 hex chars

/**
 * Generate a cryptographically secure CSRF token.
 * @returns {string} Hex-encoded CSRF token
 */
function generateCsrfToken() {
  return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
}

/**
 * Set CSRF cookie on the response.
 * Call this after login and refresh token operations.
 * @param {Object} res - Express response object
 * @param {string} token - CSRF token
 */
function setCsrfCookie(res, token) {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // Client JS needs to read this
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    maxAge: 15 * 60 * 1000, // 15 minutes (same as access token)
    path: '/',
  });
}

/**
 * Middleware: Validate CSRF token on state-changing requests.
 * Skips GET, HEAD, OPTIONS requests (safe methods).
 * Skips if no refresh token cookie is present (user not using cookie auth).
 */
function csrfProtection(req, res, next) {
  // Safe methods don't need CSRF protection
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Only enforce CSRF if the request includes cookies (cookie-based auth)
  // Requests using only Bearer token auth (no cookies) don't need CSRF
  const hasRefreshCookie = !!req.cookies?.refreshToken;
  if (!hasRefreshCookie) {
    return next();
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  if (!cookieToken || !headerToken) {
    return next(new AppError('CSRF token missing. Please refresh and try again.', 403));
  }

  // Timing-safe comparison
  const cookieBuf = Buffer.from(cookieToken);
  const headerBuf = Buffer.from(headerToken);

  if (cookieBuf.length !== headerBuf.length) {
    return next(new AppError('Invalid CSRF token.', 403));
  }

  if (!crypto.timingSafeEqual(cookieBuf, headerBuf)) {
    return next(new AppError('Invalid CSRF token.', 403));
  }

  next();
}

module.exports = {
  generateCsrfToken,
  setCsrfCookie,
  csrfProtection,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
};
