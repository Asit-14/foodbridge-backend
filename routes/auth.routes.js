const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { authLimiter, strictAuthLimiter, passwordResetLimiter } = require('../middleware/rateLimiter');
const { protect, requireFreshAuth } = require('../middleware/auth');
const { csrfProtection } = require('../middleware/csrf');
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
 * ║  - CSRF protection on state-changing requests                ║
 * ║  - 2FA management routes                                     ║
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
      gmail_remove_dots: false,
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

const verify2FAValidation = [
  body('twoFactorToken')
    .notEmpty().withMessage('Two-factor token is required')
    .isLength({ min: 64, max: 64 }).withMessage('Invalid token format')
    .isHexadecimal().withMessage('Invalid token format'),
  body('totpCode')
    .optional()
    .isLength({ min: 6, max: 6 }).withMessage('TOTP code must be 6 digits')
    .isNumeric().withMessage('TOTP code must be numeric'),
  body('backupCode')
    .optional()
    .isLength({ min: 16, max: 16 }).withMessage('Backup code must be 16 characters')
    .isHexadecimal().withMessage('Backup code must be hexadecimal'),
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

const totpCodeValidation = [
  body('totpCode')
    .notEmpty().withMessage('TOTP code is required')
    .isLength({ min: 6, max: 6 }).withMessage('TOTP code must be 6 digits')
    .isNumeric().withMessage('TOTP code must be numeric'),
];

const passwordOnlyValidation = [
  body('password')
    .notEmpty().withMessage('Password is required'),
];

const sessionIdValidation = [
  param('sessionId')
    .notEmpty().withMessage('Session ID is required')
    .isMongoId().withMessage('Invalid session ID format'),
];

// ── Public Routes (no auth required) ───────────────

// Registration
router.post(
  '/register',
  strictAuthLimiter,
  registerValidation,
  validate,
  ctrl.register
);

// Login
router.post(
  '/login',
  authLimiter,
  loginValidation,
  validate,
  ctrl.login
);

// 2FA verification (after login, before full auth)
router.post(
  '/verify-2fa',
  authLimiter,
  verify2FAValidation,
  validate,
  ctrl.verify2FA
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

// Refresh token — uses cookie
router.post(
  '/refresh-token',
  authLimiter,
  ctrl.refreshToken
);

// Forgot password
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
router.post('/logout', protect, csrfProtection, ctrl.logout);

// Logout from all devices
router.post('/logout-all', protect, csrfProtection, ctrl.logoutAll);

// Get current user
router.get('/me', protect, ctrl.getMe);

// Update profile
router.put(
  '/profile',
  protect,
  csrfProtection,
  profileUpdateValidation,
  validate,
  ctrl.updateProfile
);

// Change password
router.post(
  '/change-password',
  protect,
  csrfProtection,
  changePasswordValidation,
  validate,
  ctrl.changePassword
);

// Get active sessions
router.get('/sessions', protect, ctrl.getSessions);

// Revoke a specific session
router.delete(
  '/sessions/:sessionId',
  protect,
  csrfProtection,
  sessionIdValidation,
  validate,
  ctrl.revokeSession
);

// ── 2FA Management Routes ──────────────────────────

// Setup 2FA (generate secret + QR URI)
router.post(
  '/2fa/setup',
  protect,
  csrfProtection,
  requireFreshAuth(300),
  ctrl.setup2FA
);

// Verify 2FA setup (confirm with TOTP code, get backup codes)
router.post(
  '/2fa/verify-setup',
  protect,
  csrfProtection,
  totpCodeValidation,
  validate,
  ctrl.verifySetup2FA
);

// Disable 2FA
router.post(
  '/2fa/disable',
  protect,
  csrfProtection,
  passwordOnlyValidation,
  validate,
  ctrl.disable2FA
);

// Regenerate backup codes
router.post(
  '/2fa/regenerate-backup',
  protect,
  csrfProtection,
  passwordOnlyValidation,
  validate,
  ctrl.regenerateBackupCodes
);

module.exports = router;
