const { Router } = require('express');
const { query } = require('express-validator');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const authorize = require('../middleware/role');
const ctrl = require('../controllers/analyticsController');

const router = Router();

// All analytics routes require authentication + admin role
router.use(protect, authorize('admin'));

// ── Demand prediction ─────────────────────────────
router.get(
  '/demand-prediction',
  [
    query('city').optional().trim(),
    query('days')
      .optional()
      .isInt({ min: 1, max: 365 })
      .withMessage('Days must be between 1 and 365'),
  ],
  validate,
  ctrl.getDemandPrediction
);

// ── Heatmap data ──────────────────────────────────
router.get(
  '/heatmap',
  [
    query('days')
      .optional()
      .isInt({ min: 1, max: 365 })
      .withMessage('Days must be between 1 and 365'),
    query('status')
      .optional()
      .isIn(['Available', 'Accepted', 'PickedUp', 'Delivered', 'Expired'])
      .withMessage('Invalid status filter'),
  ],
  validate,
  ctrl.getHeatmapData
);

// ── Wastage trend ─────────────────────────────────
router.get(
  '/wastage-trend',
  [
    query('weeks')
      .optional()
      .isInt({ min: 1, max: 52 })
      .withMessage('Weeks must be between 1 and 52'),
  ],
  validate,
  ctrl.getWastageTrend
);

// ── Impact metrics ────────────────────────────────
router.get('/impact', ctrl.getImpactMetrics);

module.exports = router;
