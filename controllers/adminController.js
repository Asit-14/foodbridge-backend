const Donation = require('../models/Donation');
const User = require('../models/User');
const PickupLog = require('../models/PickupLog');
const catchAsync = require('../utils/catchAsync');
const { sendNGOVerifiedEmail } = require('../services/emailService');

/**
 * GET /api/v1/admin/analytics
 * Aggregated platform statistics via MongoDB aggregation pipeline.
 */
exports.getAnalytics = catchAsync(async (_req, res) => {
  // Run all aggregations in parallel
  const [
    donationStats,
    userCounts,
    deliveryRate,
    topNGOs,
    recentActivity,
  ] = await Promise.all([
    // ── Donation metrics ──
    Donation.aggregate([
      {
        $facet: {
          // Total quantities by status
          byStatus: [
            {
              $group: {
                _id: '$status',
                count: { $sum: 1 },
                totalQuantity: { $sum: '$quantity' },
              },
            },
          ],
          // Total food saved (delivered donations)
          totalSaved: [
            { $match: { status: 'Delivered' } },
            {
              $group: {
                _id: null,
                totalQuantity: { $sum: '$quantity' },
                totalDonations: { $sum: 1 },
              },
            },
          ],
          // Active donations right now
          activeCount: [
            { $match: { status: { $in: ['Available', 'Accepted', 'PickedUp'] } } },
            { $count: 'count' },
          ],
          // Daily trend (last 7 days)
          dailyTrend: [
            {
              $match: {
                createdAt: {
                  $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                },
              },
            },
            {
              $group: {
                _id: {
                  $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
                },
                created: { $sum: 1 },
                delivered: {
                  $sum: { $cond: [{ $eq: ['$status', 'Delivered'] }, 1, 0] },
                },
                expired: {
                  $sum: { $cond: [{ $eq: ['$status', 'Expired'] }, 1, 0] },
                },
              },
            },
            { $sort: { _id: 1 } },
          ],
          // Category breakdown
          byCategory: [
            {
              $group: {
                _id: '$category',
                count: { $sum: 1 },
                totalQuantity: { $sum: '$quantity' },
              },
            },
            { $sort: { count: -1 } },
          ],
        },
      },
    ]),

    // ── User counts by role ──
    User.aggregate([
      {
        $group: {
          _id: '$role',
          count: { $sum: 1 },
          active: { $sum: { $cond: ['$isActive', 1, 0] } },
        },
      },
    ]),

    // ── Delivery success rate ──
    PickupLog.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          delivered: {
            $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
          },
          totalBeneficiaries: { $sum: '$beneficiaryCount' },
        },
      },
    ]),

    // ── Top NGOs by deliveries ──
    PickupLog.aggregate([
      { $match: { status: 'delivered' } },
      {
        $group: {
          _id: '$ngoId',
          deliveries: { $sum: 1 },
          peopleFed: { $sum: '$beneficiaryCount' },
        },
      },
      { $sort: { deliveries: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'ngo',
        },
      },
      { $unwind: '$ngo' },
      {
        $project: {
          _id: 1,
          deliveries: 1,
          peopleFed: 1,
          'ngo.name': 1,
          'ngo.organizationName': 1,
          'ngo.reliabilityScore': 1,
        },
      },
    ]),

    // ── Recent delivery activity (last 10) ──
    PickupLog.find({ status: 'delivered' })
      .sort({ deliveryTime: -1 })
      .limit(10)
      .populate('ngoId', 'name organizationName')
      .populate('donationId', 'foodType quantity unit')
      .lean(),
  ]);

  // ── Compute summary ──
  const stats = donationStats[0];
  const totalSaved = stats.totalSaved[0] || { totalQuantity: 0, totalDonations: 0 };
  const activeCount = stats.activeCount[0]?.count || 0;
  const delivery = deliveryRate[0] || { total: 0, delivered: 0, failed: 0, totalBeneficiaries: 0 };

  const successRate = delivery.total > 0
    ? Math.round((delivery.delivered / delivery.total) * 100)
    : 0;

  const userMap = {};
  for (const u of userCounts) {
    userMap[u._id] = { total: u.count, active: u.active };
  }

  res.status(200).json({
    status: 'success',
    data: {
      summary: {
        totalFoodQuantitySaved: totalSaved.totalQuantity,
        totalDonationsDelivered: totalSaved.totalDonations,
        activeDonations: activeCount,
        deliverySuccessRate: `${successRate}%`,
        totalBeneficiariesFed: delivery.totalBeneficiaries,
      },
      users: {
        donors: userMap.donor || { total: 0, active: 0 },
        ngos: userMap.ngo || { total: 0, active: 0 },
        admins: userMap.admin || { total: 0, active: 0 },
      },
      donationsByStatus: stats.byStatus,
      donationsByCategory: stats.byCategory,
      dailyTrend: stats.dailyTrend,
      topNGOs,
      recentDeliveries: recentActivity,
    },
  });
});

/**
 * GET /api/v1/admin/users
 * List all users with optional filters.
 */
exports.getUsers = catchAsync(async (req, res) => {
  const { role, active, page = 1, limit = 20 } = req.query;
  const filter = {};

  if (role) filter.role = role;
  if (active !== undefined) filter.isActive = active === 'true';

  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10)),
    User.countDocuments(filter),
  ]);

  res.status(200).json({
    status: 'success',
    results: users.length,
    total,
    data: { users },
  });
});

/**
 * PUT /api/v1/admin/users/:id/status
 * Activate or deactivate a user.
 */
exports.updateUserStatus = catchAsync(async (req, res) => {
  const { isActive, isVerified } = req.body;
  const update = {};

  if (isActive !== undefined) update.isActive = isActive;
  if (isVerified !== undefined) update.isVerified = isVerified;

  const user = await User.findByIdAndUpdate(req.params.id, update, {
    new: true,
    runValidators: true,
  });

  // Send verification email to NGO when verified
  if (isVerified === true && user && user.role === 'ngo') {
    sendNGOVerifiedEmail(user).catch(() => {});
  }

  res.status(200).json({
    status: 'success',
    data: { user },
  });
});
