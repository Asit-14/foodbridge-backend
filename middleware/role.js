const AppError = require('../utils/AppError');

/**
 * Role-based access guard.
 * Pass allowed roles as arguments:
 *   router.get('/admin', protect, authorize('admin'), handler);
 *   router.get('/both', protect, authorize('donor', 'admin'), handler);
 */
const authorize = (...roles) => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required before authorization.', 401));
    }

    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action.', 403)
      );
    }

    next();
  };
};

module.exports = authorize;
