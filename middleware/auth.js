const AppError = require('../utils/AppError');
const User = require('../models/User');
const { verifyAccessToken } = require('../utils/jwtUtils');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                AUTHENTICATION MIDDLEWARE                      ║
 * ║                                                              ║
 * ║  JWT verification and user session validation with:          ║
 * ║  - Token extraction from Authorization header                ║
 * ║  - Token signature verification                              ║
 * ║  - User existence and status checks                          ║
 * ║  - Password change detection                                 ║
 * ║  - Email verification check (optional)                       ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

/**
 * Main authentication middleware
 * Extracts and verifies JWT from Authorization header
 * Attaches full user document to req.user
 */
const protect = async (req, _res, next) => {
  try {
    // 1. Extract token from Authorization header
    let token;
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    if (!token) {
      return next(new AppError('Authentication required. Please log in.', 401));
    }

    // 2. Verify token signature and expiry
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return next(new AppError('Token expired. Please refresh or log in again.', 401));
      }
      if (err.name === 'JsonWebTokenError') {
        return next(new AppError('Invalid token. Please log in again.', 401));
      }
      throw err;
    }

    // 3. Check if user still exists
    const user = await User.findById(decoded.id);
    if (!user) {
      return next(new AppError('User belonging to this token no longer exists.', 401));
    }

    // 4. Check if user is active
    if (!user.isActive) {
      return next(new AppError('Account has been deactivated. Contact support.', 403));
    }

    // 5. Check if password was changed after token was issued
    if (user.changedPasswordAfter(decoded.iat)) {
      return next(
        new AppError('Password was recently changed. Please log in again.', 401)
      );
    }

    // 6. Attach user to request
    req.user = user;
    next();

  } catch (err) {
    next(err);
  }
};

/**
 * Optional authentication middleware
 * Similar to protect but doesn't fail if no token is provided
 * Useful for routes that have different behavior for authenticated users
 */
const optionalAuth = async (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(); // No token, continue without user
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = verifyAccessToken(token);
      const user = await User.findById(decoded.id);
      
      if (user && user.isActive && !user.changedPasswordAfter(decoded.iat)) {
        req.user = user;
      }
    } catch {
      // Token invalid but that's okay for optional auth
    }

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Email verification requirement middleware
 * Use after protect middleware when email verification is required
 */
const requireEmailVerified = (req, _res, next) => {
  if (!req.user) {
    return next(new AppError('Authentication required.', 401));
  }

  if (!req.user.isEmailVerified) {
    return next(
      new AppError(
        'Please verify your email address to access this resource.',
        403
      )
    );
  }

  next();
};

/**
 * NGO verification requirement middleware
 * Use after protect middleware when admin verification is required for NGOs
 */
const requireVerified = (req, _res, next) => {
  if (!req.user) {
    return next(new AppError('Authentication required.', 401));
  }

  // Only NGOs need admin verification
  if (req.user.role === 'ngo' && !req.user.isVerified) {
    return next(
      new AppError(
        'Your account is pending admin verification. Please wait for approval.',
        403
      )
    );
  }

  next();
};

/**
 * Account not locked middleware
 * Prevents locked accounts from performing actions
 */
const requireNotLocked = async (req, _res, next) => {
  if (!req.user) {
    return next(new AppError('Authentication required.', 401));
  }

  // Fetch user with lock fields
  const user = await User.findById(req.user._id).select('+lockUntil');
  
  if (user.isLocked) {
    const lockRemaining = Math.ceil((user.lockUntil - Date.now()) / 60000);
    return next(
      new AppError(
        `Account is temporarily locked. Try again in ${lockRemaining} minutes.`,
        423
      )
    );
  }

  next();
};

/**
 * Fresh authentication required
 * For sensitive operations, require recent authentication
 * @param {number} maxAge - Maximum age of authentication in seconds (default: 5 minutes)
 */
const requireFreshAuth = (maxAge = 300) => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required.', 401));
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError('Authentication required.', 401));
    }

    const token = authHeader.split(' ')[1];
    
    try {
      const decoded = verifyAccessToken(token);
      const tokenAge = Math.floor(Date.now() / 1000) - decoded.iat;
      
      if (tokenAge > maxAge) {
        return next(
          new AppError(
            'This action requires recent authentication. Please log in again.',
            401
          )
        );
      }
      
      next();
    } catch (err) {
      next(new AppError('Invalid token.', 401));
    }
  };
};

module.exports = {
  protect,
  optionalAuth,
  requireEmailVerified,
  requireVerified,
  requireNotLocked,
  requireFreshAuth,
};
