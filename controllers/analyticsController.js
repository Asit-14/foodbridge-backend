const Donation = require('../models/Donation');
const PickupLog = require('../models/PickupLog');
const catchAsync = require('../utils/catchAsync');
const { predictDemand } = require('../services/demandPrediction');

/**
 * GET /api/v1/analytics/demand-prediction
 * AI-powered demand forecast based on historical patterns.
 */
exports.getDemandPrediction = catchAsync(async (req, res) => {
  const { city, days = 30 } = req.query;
  const prediction = await predictDemand({
    city,
    daysBack: parseInt(days, 10),
  });

  res.status(200).json({ status: 'success', data: prediction });
});

/**
 * GET /api/v1/analytics/heatmap
 * Geospatial donation density data for map visualization.
 */
exports.getHeatmapData = catchAsync(async (req, res) => {
  const { days = 30, status } = req.query;
  const since = new Date(Date.now() - parseInt(days, 10) * 86400000);

  const match = { createdAt: { $gte: since } };
  if (status) match.status = status;

  const points = await Donation.aggregate([
    { $match: match },
    {
      $project: {
        lat: { $arrayElemAt: ['$location.coordinates', 1] },
        lng: { $arrayElemAt: ['$location.coordinates', 0] },
        quantity: 1,
        status: 1,
      },
    },
    {
      $group: {
        _id: {
          lat: { $round: ['$lat', 2] },
          lng: { $round: ['$lng', 2] },
        },
        count: { $sum: 1 },
        totalQuantity: { $sum: '$quantity' },
        statuses: { $push: '$status' },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 200 },
  ]);

  const heatmap = points.map((p) => ({
    lat: p._id.lat,
    lng: p._id.lng,
    intensity: p.count,
    quantity: p.totalQuantity,
  }));

  res.status(200).json({
    status: 'success',
    results: heatmap.length,
    data: { heatmap },
  });
});

/**
 * GET /api/v1/analytics/wastage-trend
 * Weekly waste reduction metrics for trend visualization.
 */
exports.getWastageTrend = catchAsync(async (req, res) => {
  const { weeks = 12 } = req.query;
  const since = new Date(Date.now() - parseInt(weeks, 10) * 7 * 86400000);

  const trend = await Donation.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: {
          year: { $isoWeekYear: '$createdAt' },
          week: { $isoWeek: '$createdAt' },
        },
        totalCreated: { $sum: 1 },
        totalDelivered: {
          $sum: { $cond: [{ $eq: ['$status', 'Delivered'] }, 1, 0] },
        },
        totalExpired: {
          $sum: { $cond: [{ $eq: ['$status', 'Expired'] }, 1, 0] },
        },
        quantitySaved: {
          $sum: {
            $cond: [{ $eq: ['$status', 'Delivered'] }, '$quantity', 0],
          },
        },
        quantityWasted: {
          $sum: {
            $cond: [{ $eq: ['$status', 'Expired'] }, '$quantity', 0],
          },
        },
      },
    },
    { $sort: { '_id.year': 1, '_id.week': 1 } },
  ]);

  // Compute waste reduction rate per week
  const formatted = trend.map((w) => {
    const total = w.totalDelivered + w.totalExpired || 1;
    return {
      week: `${w._id.year}-W${String(w._id.week).padStart(2, '0')}`,
      created: w.totalCreated,
      delivered: w.totalDelivered,
      expired: w.totalExpired,
      quantitySaved: w.quantitySaved,
      quantityWasted: w.quantityWasted,
      wasteReductionRate: `${Math.round((w.totalDelivered / total) * 100)}%`,
    };
  });

  res.status(200).json({
    status: 'success',
    data: { trend: formatted },
  });
});

/**
 * GET /api/v1/analytics/impact
 * Overall platform impact metrics.
 */
exports.getImpactMetrics = catchAsync(async (req, res) => {
  const [impact] = await Donation.aggregate([
    {
      $facet: {
        overall: [
          {
            $group: {
              _id: null,
              totalDonations: { $sum: 1 },
              totalDelivered: {
                $sum: { $cond: [{ $eq: ['$status', 'Delivered'] }, 1, 0] },
              },
              totalExpired: {
                $sum: { $cond: [{ $eq: ['$status', 'Expired'] }, 1, 0] },
              },
              totalQuantitySaved: {
                $sum: { $cond: [{ $eq: ['$status', 'Delivered'] }, '$quantity', 0] },
              },
            },
          },
        ],
        beneficiaries: [
          {
            $lookup: {
              from: 'pickuplogs',
              localField: '_id',
              foreignField: 'donationId',
              as: 'pickup',
            },
          },
          { $unwind: { path: '$pickup', preserveNullAndEmptyArrays: true } },
          {
            $group: {
              _id: null,
              totalBeneficiaries: { $sum: { $ifNull: ['$pickup.beneficiaryCount', 0] } },
            },
          },
        ],
        // Environmental impact estimate
        // Avg food waste = 2.5 kg CO2 per kg of food wasted
        co2Estimate: [
          { $match: { status: 'Delivered' } },
          {
            $group: {
              _id: null,
              totalKgSaved: { $sum: '$quantity' },
            },
          },
        ],
      },
    },
  ]);

  const overall = impact.overall[0] || {};
  const bene = impact.beneficiaries[0] || {};
  const co2 = impact.co2Estimate[0] || {};

  res.status(200).json({
    status: 'success',
    data: {
      totalDonations: overall.totalDonations || 0,
      totalDelivered: overall.totalDelivered || 0,
      totalExpired: overall.totalExpired || 0,
      totalQuantitySaved: overall.totalQuantitySaved || 0,
      totalBeneficiaries: bene.totalBeneficiaries || 0,
      estimatedCO2SavedKg: Math.round((co2.totalKgSaved || 0) * 2.5),
      wasteReductionRate: overall.totalDonations
        ? `${Math.round((overall.totalDelivered / overall.totalDonations) * 100)}%`
        : '0%',
    },
  });
});
