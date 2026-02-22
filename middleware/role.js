const { AuthenticationError, AuthorizationError } = require('../utils/AppError');

/**
 * Role-based access guard.
 *   router.get('/admin', protect, authorize('admin'), handler);
 */
const authorize = (...roles) => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AuthenticationError('Authentication required before authorization.'));
    }

    if (!roles.includes(req.user.role)) {
      return next(new AuthorizationError('You do not have permission to perform this action.'));
    }

    next();
  };
};

module.exports = authorize;
