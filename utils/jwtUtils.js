const jwt = require('jsonwebtoken');
const env = require('../config/env');

const ALGORITHM = 'HS256';

/**
 * Sign a JWT access token (1 hour expiry).
 */
function signAccessToken(user) {
  return jwt.sign(
    { userId: user._id, role: user.role },
    env.jwt.secret,
    { algorithm: ALGORITHM, expiresIn: env.jwt.expiresIn || '1h' }
  );
}

/**
 * Verify a JWT access token.
 */
function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.secret, { algorithms: [ALGORITHM] });
}

module.exports = { signAccessToken, verifyAccessToken };
