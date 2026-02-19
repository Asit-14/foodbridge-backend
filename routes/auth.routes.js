const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { authLimiter, strictAuthLimiter, passwordResetLimiter } = require('../middleware/rateLimiter');
const { protect } = require('../middleware/auth');
const ctrl = require('../controllers/authController');

const router = Router();

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                   AUTH ROUTES                                ║
 * ║                                                              ║
 * ║  All authentication endpoints with:                          ║
 * ║  - Input validation using express-validator                  ║
 * ║  - Rate limiting per endpoint type                          ║
 * ║  - Strong password requirements                             ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── Password validation rules ──────────────────────

const passwordRules = body('password')
  .notEmpty().withMessage('Password is required')
  .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  .isLength({ max: 128 }).withMessage('Password must not exceed 128 characters')
  .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
  .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
  .matches(/\d/).withMessage('Password must contain at least one number')
  .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Password must contain at least one special character')
  .not().matches(/\s/).withMessage('Password must not contain spaces')
  .custom((value, { req }) => {
    // Check password doesn't contain email or name
    const email = req.body.email?.toLowerCase() || '';
    const name = req.body.name?.toLowerCase() || '';
    const lowerPassword = value.toLowerCase();
    
    if (email && lowerPassword.includes(email.split('@')[0])) {
      throw new Error('Password must not contain your email');
    }
    if (name && name.length > 3 && lowerPassword.includes(name)) {
      throw new Error('Password must not contain your name');
    }
    return true;
  });

// ── Validation chains ──────────────────────────────

const registerValidation = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters')
    .matches(/^[a-zA-Z\s'-]+$/).withMessage('Name can only contain letters, spaces, hyphens, and apostrophes'),
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Please provide a valid email')
    .isLength({ max: 254 }).withMessage('Email must not exceed 254 characters')
    .normalizeEmail({
      gmail_remove_dots: false, // Preserve dots in gmail addresses
      gmail_remove_subaddress: false,
    }),
  passwordRules,
  body('role')
    .notEmpty().withMessage('Role is required')
    .isIn(['donor', 'ngo']).withMessage('Role must be donor or ngo'),
  body('phone')
    .optional()
    .trim()
    .isMobilePhone('any', { strictMode: false }).withMessage('Invalid phone number'),
  body('organizationName')
    .optional()
    .trim()
    .isLength({ max: 200 }).withMessage('Organization name must not exceed 200 characters'),
  body('address')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Address must not exceed 500 characters'),
  body('location.coordinates')
    .optional()
    .isArray({ min: 2, max: 2 }).withMessage('Coordinates must be [longitude, latitude]'),
  body('location.coordinates.0')
    .optional()
    .isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),
  body('location.coordinates.1')
    .optional()
    .isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
];

const loginValidation = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format')
    .normalizeEmail(),
  body('password')
    .notEmpty().withMessage('Password is required'),
];

const emailValidation = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format')
    .normalizeEmail(),
];

const tokenParamValidation = [
  param('token')
    .trim()
    .notEmpty().withMessage('Token is required')
    .isLength({ min: 64, max: 64 }).withMessage('Invalid token format')
    .isHexadecimal().withMessage('Invalid token format'),
];

const resetPasswordValidation = [
  ...tokenParamValidation,
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .isLength({ max: 128 }).withMessage('Password must not exceed 128 characters')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/\d/).withMessage('Password must contain at least one number')
    .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Password must contain at least one special character'),
];

const changePasswordValidation = [
  body('currentPassword')
    .notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
    .isLength({ max: 128 }).withMessage('New password must not exceed 128 characters')
    .matches(/[a-z]/).withMessage('New password must contain at least one lowercase letter')
    .matches(/[A-Z]/).withMessage('New password must contain at least one uppercase letter')
    .matches(/\d/).withMessage('New password must contain at least one number')
    .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('New password must contain at least one special character')
    .custom((value, { req }) => {
      if (value === req.body.currentPassword) {
        throw new Error('New password must be different from current password');
      }
      return true;
    }),
  body('confirmPassword')
    .notEmpty().withMessage('Password confirmation is required')
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error('Passwords do not match');
      }
      return true;
    }),
];

const profileUpdateValidation = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters')
    .matches(/^[a-zA-Z\s'-]+$/).withMessage('Name can only contain letters, spaces, hyphens, and apostrophes'),
  body('phone')
    .optional()
    .trim()
    .isMobilePhone('any', { strictMode: false }).withMessage('Invalid phone number'),
  body('organizationName')
    .optional()
    .trim()
    .isLength({ max: 200 }).withMessage('Organization name must not exceed 200 characters'),
  body('address')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Address must not exceed 500 characters'),
  body('location.coordinates')
    .optional()
    .isArray({ min: 2, max: 2 }).withMessage('Coordinates must be [longitude, latitude]'),
  body('location.coordinates.0')
    .optional()
    .isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),
  body('location.coordinates.1')
    .optional()
    .isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
];

// ── Public Routes (no auth required) ───────────────

// Registration - strict rate limit
router.post(
  '/register',
  strictAuthLimiter,
  registerValidation,
  validate,
  ctrl.register
);

// Login - standard auth rate limit with account lockout
router.post(
  '/login',
  authLimiter,
  loginValidation,
  validate,
  ctrl.login
);

// Email verification
router.get(
  '/verify-email/:token',
  authLimiter,
  tokenParamValidation,
  validate,
  ctrl.verifyEmail
);

// Resend verification email
router.post(
  '/resend-verification',
  passwordResetLimiter,
  emailValidation,
  validate,
  ctrl.resendVerification
);

// Refresh token - uses cookie, apply rate limit
router.post(
  '/refresh-token',
  authLimiter,
  ctrl.refreshToken
);

// Forgot password - strict rate limit to prevent abuse
router.post(
  '/forgot-password',
  passwordResetLimiter,
  emailValidation,
  validate,
  ctrl.forgotPassword
);

// Reset password with token
router.post(
  '/reset-password/:token',
  passwordResetLimiter,
  resetPasswordValidation,
  validate,
  ctrl.resetPassword
);

// ── Protected Routes (auth required) ───────────────

// Logout
router.post('/logout', protect, ctrl.logout);

// Logout from all devices
router.post('/logout-all', protect, ctrl.logoutAll);

// Get current user
router.get('/me', protect, ctrl.getMe);

// Update profile
router.put(
  '/profile',
  protect,
  profileUpdateValidation,
  validate,
  ctrl.updateProfile
);

// Change password
router.post(
  '/change-password',
  protect,
  changePasswordValidation,
  validate,
  ctrl.changePassword
);

// Get active sessions
router.get('/sessions', protect, ctrl.getSessions);

module.exports = router;
