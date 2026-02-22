const { AuthenticationError, AuthorizationError } = require('../utils/AppError');
const User = require('../models/User');
const { verifyAccessToken } = require('../utils/jwtUtils');

/**
 * JWT authentication middleware.
 * Extracts Bearer token, verifies it, attaches user to req.user.
 */
const protect = async (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AuthenticationError('Authentication required. Please log in.'));
    }
    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return next(new AuthenticationError('Token expired. Please log in again.'));
      }
      return next(new AuthenticationError('Invalid token. Please log in again.'));
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return next(new AuthenticationError('User belonging to this token no longer exists.'));
    }
    if (!user.isActive) {
      return next(new AuthorizationError('Account has been deactivated. Contact support.'));
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { protect };
