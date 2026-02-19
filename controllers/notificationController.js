const Notification = require('../models/Notification');
const catchAsync = require('../utils/catchAsync');

/**
 * GET /api/v1/notifications
 * Paginated notifications for the authenticated user.
 */
exports.getNotifications = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find({ recipientId: req.user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10)),
    Notification.countDocuments({ recipientId: req.user._id }),
    Notification.countDocuments({ recipientId: req.user._id, isRead: false }),
  ]);

  res.status(200).json({
    status: 'success',
    results: notifications.length,
    total,
    unreadCount,
    data: { notifications },
  });
});

/**
 * PUT /api/v1/notifications/:id/read
 */
exports.markAsRead = catchAsync(async (req, res) => {
  await Notification.findOneAndUpdate(
    { _id: req.params.id, recipientId: req.user._id },
    { isRead: true, readAt: new Date() }
  );

  res.status(200).json({ status: 'success' });
});

/**
 * PUT /api/v1/notifications/read-all
 */
exports.markAllRead = catchAsync(async (req, res) => {
  await Notification.updateMany(
    { recipientId: req.user._id, isRead: false },
    { isRead: true, readAt: new Date() }
  );

  res.status(200).json({ status: 'success' });
});

/**
 * GET /api/v1/notifications/unread-count
 */
exports.getUnreadCount = catchAsync(async (req, res) => {
  const count = await Notification.countDocuments({
    recipientId: req.user._id,
    isRead: false,
  });

  res.status(200).json({ status: 'success', data: { unreadCount: count } });
});
