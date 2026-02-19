const { Router } = require('express');
const { body, query } = require('express-validator');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const authorize = require('../middleware/role');
const ctrl = require('../controllers/donationController');

const router = Router();

// ── Validation chains ──────────────────────────────

const createDonationValidation = [
  body('foodType')
    .trim()
    .notEmpty().withMessage('Food type is required'),
  body('category')
    .optional()
    .isIn(['cooked_meal', 'raw_ingredients', 'packaged', 'bakery', 'beverages', 'mixed'])
    .withMessage('Invalid food category'),
  body('quantity')
    .notEmpty().withMessage('Quantity is required')
    .isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('unit')
    .optional()
    .isIn(['servings', 'kg', 'packets', 'trays'])
    .withMessage('Invalid unit'),
  body('expiryTime')
    .notEmpty().withMessage('Expiry time is required')
    .isISO8601().withMessage('Expiry time must be a valid date'),
  body('pickupDeadline')
    .notEmpty().withMessage('Pickup deadline is required')
    .isISO8601().withMessage('Pickup deadline must be a valid date'),
  body('location.coordinates')
    .notEmpty().withMessage('Location coordinates are required')
    .isArray({ min: 2, max: 2 }).withMessage('Coordinates must be [lng, lat]'),
  body('location.coordinates.0')
    .isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  body('location.coordinates.1')
    .isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  body('pickupAddress')
    .trim()
    .notEmpty().withMessage('Pickup address is required'),
];

const nearbyQueryValidation = [
  query('lat')
    .notEmpty().withMessage('Latitude is required')
    .isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  query('lng')
    .notEmpty().withMessage('Longitude is required')
    .isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  query('radius')
    .optional()
    .isFloat({ min: 0.1, max: 50 }).withMessage('Radius must be between 0.1 and 50 km'),
];

const otpValidation = [
  body('otp')
    .trim()
    .notEmpty().withMessage('OTP is required')
    .isLength({ min: 4, max: 4 }).withMessage('OTP must be 4 digits'),
];

// ── All routes require authentication ──────────────
router.use(protect);

// ── Donor routes ───────────────────────────────────
router.post(
  '/',
  authorize('donor'),
  createDonationValidation,
  validate,
  ctrl.createDonation
);

router.get(
  '/my-donations',
  authorize('donor'),
  ctrl.getMyDonations
);

// ── NGO routes ─────────────────────────────────────
router.get(
  '/nearby',
  authorize('ngo'),
  nearbyQueryValidation,
  validate,
  ctrl.getNearbyDonations
);

router.put(
  '/:id/accept',
  authorize('ngo'),
  ctrl.acceptDonation
);

router.put(
  '/:id/pickup',
  authorize('ngo'),
  otpValidation,
  validate,
  ctrl.pickupDonation
);

router.put(
  '/:id/deliver',
  authorize('ngo'),
  ctrl.deliverDonation
);

// ── Donor cancel ────────────────────────────────────
router.put(
  '/:id/cancel',
  authorize('donor'),
  ctrl.cancelDonation
);

// ── Donor edit (only while Available) ───────────────
router.put(
  '/:id',
  authorize('donor'),
  ctrl.editDonation
);

// ── Shared routes ──────────────────────────────────
router.get('/', ctrl.getDonations);
router.get('/:id', ctrl.getDonation);

router.get(
  '/:id/match',
  authorize('donor', 'admin'),
  ctrl.getMatchSuggestions
);

router.get(
  '/:id/risk',
  ctrl.getExpiryRisk
);

module.exports = router;
