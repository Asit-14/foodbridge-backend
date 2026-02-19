const { Router } = require('express');
const { protect } = require('../middleware/auth');
const authorize = require('../middleware/role');
const ctrl = require('../controllers/adminController');

const router = Router();

// All admin routes require authentication + admin role
router.use(protect, authorize('admin'));

router.get('/analytics', ctrl.getAnalytics);
router.get('/users', ctrl.getUsers);
router.put('/users/:id/status', ctrl.updateUserStatus);

module.exports = router;
