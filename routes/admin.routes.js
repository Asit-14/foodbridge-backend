const { Router } = require('express');
const { query, param } = require('express-validator');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const authorize = require('../middleware/role');
const ctrl = require('../controllers/adminController');

const router = Router();

// All admin routes require authentication + admin role
router.use(protect, authorize('admin'));

router.get('/analytics', ctrl.getAnalytics);

// ── City-based analytics ──
router.get(
  '/analytics/city',
  [
    query('days')
      .optional()
      .isInt({ min: 1, max: 365 })
      .withMessage('Days must be between 1 and 365'),
  ],
  validate,
  ctrl.getCityAnalytics
);

// ── City leaderboard ──
router.get('/analytics/city-leaderboard', ctrl.getCityLeaderboard);

router.get('/users', ctrl.getUsers);
router.put(
  '/users/:id/status',
  [param('id').isMongoId().withMessage('Invalid user ID')],
  validate,
  ctrl.updateUserStatus
);

module.exports = router;
