const { Router } = require('express');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authLimiter, strictAuthLimiter } = require('../middleware/rateLimiter');
const { protect } = require('../middleware/auth');
const ctrl = require('../controllers/authController');

const router = Router();

// ── Validation chains ──────────────────────────────

const registerValidation = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Please provide a valid email')
    .normalizeEmail(),
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('role')
    .notEmpty().withMessage('Role is required')
    .isIn(['donor', 'ngo']).withMessage('Role must be donor or ngo'),
  body('phone')
    .optional().trim()
    .isMobilePhone('any').withMessage('Invalid phone number'),
  body('organizationName')
    .optional().trim()
    .isLength({ max: 200 }).withMessage('Organization name must not exceed 200 characters'),
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

const profileUpdateValidation = [
  body('name')
    .optional().trim()
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
  body('phone')
    .optional().trim()
    .isMobilePhone('any').withMessage('Invalid phone number'),
  body('organizationName')
    .optional().trim()
    .isLength({ max: 200 }).withMessage('Organization name must not exceed 200 characters'),
  body('address')
    .optional().trim()
    .isLength({ max: 500 }).withMessage('Address must not exceed 500 characters'),
];

// ── Public routes ───────────────────────────────────
router.post('/register', strictAuthLimiter, registerValidation, validate, ctrl.register);
router.post('/login', authLimiter, loginValidation, validate, ctrl.login);

// ── Protected routes ────────────────────────────────
router.get('/me', protect, ctrl.getMe);
router.post('/logout', protect, ctrl.logout);
router.put('/profile', protect, profileUpdateValidation, validate, ctrl.updateProfile);

module.exports = router;
