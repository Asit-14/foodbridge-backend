const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                    JWT UTILITY MODULE                        ║
 * ║                                                              ║
 * ║  Centralized JWT operations for access and refresh tokens.   ║
 * ║  - Access tokens: Short-lived (15 min), contain user role    ║
 * ║  - Refresh tokens: Long-lived (7 days), used for rotation    ║
 * ║                                                              ║
 * ║  Security features:                                          ║
 * ║  - Separate secrets for access/refresh tokens                ║
 * ║  - Algorithm pinned to HS256 (prevents confusion attacks)    ║
 * ║  - Token ID (jti) for revocation capability                  ║
 * ║  - tokenVersion for forced invalidation                      ║
 * ║  - Issuer and audience claims for validation                 ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const TOKEN_ISSUER = 'foodbridge-api';
const TOKEN_AUDIENCE = 'foodbridge-client';
const ALGORITHM = 'HS256';

/**
 * Generate a unique token ID for tracking/revocation
 */
function generateTokenId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Sign an access token (short-lived)
 * @param {Object} user - User document from MongoDB
 * @returns {string} Signed JWT access token
 */
function signAccessToken(user) {
  const payload = {
    id: user._id,
    role: user.role,
    tokenVersion: user.tokenVersion || 0,
    jti: generateTokenId(),
  };

  return jwt.sign(payload, env.jwt.secret, {
    algorithm: ALGORITHM,
    expiresIn: env.jwt.expiresIn || '15m',
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    subject: user._id.toString(),
  });
}

/**
 * Sign a refresh token (long-lived)
 * @param {Object} user - User document from MongoDB
 * @returns {string} Signed JWT refresh token
 */
function signRefreshToken(user) {
  const payload = {
    id: user._id,
    jti: generateTokenId(),
    type: 'refresh',
    tokenVersion: user.tokenVersion || 0,
  };

  return jwt.sign(payload, env.jwt.refreshSecret, {
    algorithm: ALGORITHM,
    expiresIn: env.jwt.refreshExpiresIn || '7d',
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    subject: user._id.toString(),
  });
}

/**
 * Verify an access token
 * @param {string} token - JWT access token
 * @returns {Object} Decoded token payload
 * @throws {JsonWebTokenError|TokenExpiredError}
 */
function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.secret, {
    algorithms: [ALGORITHM],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  });
}

/**
 * Verify a refresh token
 * @param {string} token - JWT refresh token
 * @returns {Object} Decoded token payload
 * @throws {JsonWebTokenError|TokenExpiredError}
 */
function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, env.jwt.refreshSecret, {
    algorithms: [ALGORITHM],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  });

  // Ensure it's actually a refresh token
  if (decoded.type !== 'refresh') {
    throw new jwt.JsonWebTokenError('Invalid token type');
  }

  return decoded;
}

/**
 * Decode a token without verification (for debugging/logging)
 * @param {string} token - JWT token
 * @returns {Object|null} Decoded payload or null if invalid
 */
function decodeToken(token) {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
}

/**
 * Hash a refresh token for database storage
 * Prevents token theft if database is compromised
 * @param {string} token - Plain refresh token
 * @returns {string} Hashed token
 */
function hashRefreshToken(token) {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
}

/**
 * Compare a plain token against a hashed version
 * Uses timing-safe comparison to prevent timing attacks
 * @param {string} plainToken - Plain refresh token
 * @param {string} hashedToken - Hashed token from database
 * @returns {boolean} Whether tokens match
 */
function compareRefreshToken(plainToken, hashedToken) {
  const hash = hashRefreshToken(plainToken);
  const hashBuf = Buffer.from(hash);
  const storedBuf = Buffer.from(hashedToken);

  if (hashBuf.length !== storedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(hashBuf, storedBuf);
}

/**
 * Get token expiry times in milliseconds
 * @returns {Object} Object containing access and refresh expiry times
 */
function getTokenExpiries() {
  const parseExpiry = (exp) => {
    const match = exp.match(/^(\d+)([smhd])$/);
    if (!match) return 15 * 60 * 1000; // Default 15 minutes

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return value * multipliers[unit];
  };

  return {
    accessToken: parseExpiry(env.jwt.expiresIn || '15m'),
    refreshToken: parseExpiry(env.jwt.refreshExpiresIn || '7d'),
  };
}

/**
 * Cookie options for refresh token
 * @returns {Object} Cookie configuration object
 */
function getRefreshTokenCookieOptions() {
  const expiries = getTokenExpiries();

  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    maxAge: expiries.refreshToken,
    path: '/api/v1/auth',
  };
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  decodeToken,
  hashRefreshToken,
  compareRefreshToken,
  getTokenExpiries,
  getRefreshTokenCookieOptions,
};
