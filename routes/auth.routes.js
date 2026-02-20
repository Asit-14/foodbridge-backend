const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { authLimiter, strictAuthLimiter, passwordResetLimiter } = require('../middleware/rateLimiter');
const { protect } = require('../middleware/auth');
const ctrl = require('../controllers/authController');
const {
  password, newPassword, confirmPassword, currentPassword,
  hexToken, customValidators,
} = require('../utils/validators');

const router = Router();

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                   AUTH ROUTES                                ║
 * ║                                                              ║
 * ║  All authentication endpoints with:                          ║
 * ║  - Input validation using express-validator                  ║
 * ║  - Rate limiting per endpoint type                          ║
 * ║  - Strong password requirements (from utils/validators)     ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

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
  password().custom(customValidators.noPersonalInfo),
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

const tokenParamValidation = [hexToken('param')];

const resetPasswordValidation = [
  ...tokenParamValidation,
  password(),
];

const changePasswordValidation = [
  currentPassword,
  newPassword,
  confirmPassword,
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
