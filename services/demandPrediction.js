const Donation = require('../models/Donation');
const logger = require('../utils/logger');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          DEMAND PREDICTION MODULE                           ║
 * ║                                                             ║
 * ║  Lightweight ML-inspired prediction without model training. ║
 * ║  Uses MongoDB aggregation over historical donation data to  ║
 * ║  identify temporal and spatial patterns, then extrapolates  ║
 * ║  demand forecasts for the next 24 hours.                    ║
 * ║                                                             ║
 * ║  Approach:                                                  ║
 * ║    1. Cluster donations by geo-hash grid cells              ║
 * ║    2. Aggregate by hour-of-day and day-of-week              ║
 * ║    3. Compute moving averages and trend coefficients         ║
 * ║    4. Output: which areas will need food, when              ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── Grid resolution for area clustering ──────────
// Round coordinates to ~1km grid cells
const GRID_PRECISION = 2; // decimal places (0.01° ≈ 1.1km)

function toGridCell(coords) {
  const lng = parseFloat(coords[0].toFixed(GRID_PRECISION));
  const lat = parseFloat(coords[1].toFixed(GRID_PRECISION));
  return { lng, lat, key: `${lat},${lng}` };
}

/**
 * Predict demand hotspots for the next 24 hours.
 *
 * @param {Object} opts
 * @param {string} [opts.city]       Optional city filter
 * @param {number} [opts.daysBack]   Historical window (default 30)
 * @returns {Object}  { hotspots, hourlyForecast, patterns }
 */
async function predictDemand({ city, daysBack = 30 } = {}) {
  const sinceDate = new Date(Date.now() - daysBack * 24 * 3600 * 1000);

  const matchStage = {
    createdAt: { $gte: sinceDate },
    status: { $in: ['Delivered', 'Expired', 'Available', 'Accepted', 'PickedUp'] },
  };
  if (city) {
    matchStage.pickupAddress = { $regex: city, $options: 'i' };
  }

  // ── 1. Spatial hotspots: where do donations cluster? ──
  const spatialClusters = await Donation.aggregate([
    { $match: matchStage },
    {
      $project: {
        gridLat: {
          $round: [{ $arrayElemAt: ['$location.coordinates', 1] }, GRID_PRECISION],
        },
        gridLng: {
          $round: [{ $arrayElemAt: ['$location.coordinates', 0] }, GRID_PRECISION],
        },
        quantity: 1,
        status: 1,
        hour: { $hour: '$createdAt' },
        dayOfWeek: { $dayOfWeek: '$createdAt' },
      },
    },
    {
      $group: {
        _id: { lat: '$gridLat', lng: '$gridLng' },
        totalDonations: { $sum: 1 },
        totalQuantity: { $sum: '$quantity' },
        avgQuantity: { $avg: '$quantity' },
        deliveredCount: {
          $sum: { $cond: [{ $eq: ['$status', 'Delivered'] }, 1, 0] },
        },
        expiredCount: {
          $sum: { $cond: [{ $eq: ['$status', 'Expired'] }, 1, 0] },
        },
        // Collect peak hours
        peakHours: { $push: '$hour' },
      },
    },
    { $sort: { totalDonations: -1 } },
    { $limit: 20 },
  ]);

  // ── Process hotspots: identify peak hours per cell ──
  const hotspots = spatialClusters.map((cell) => {
    // Count hour frequency to find peak
    const hourFreq = {};
    for (const h of cell.peakHours) {
      hourFreq[h] = (hourFreq[h] || 0) + 1;
    }
    const peakHour = Object.entries(hourFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([h]) => parseInt(h));

    const wasteRate = cell.totalDonations > 0
      ? Math.round((cell.expiredCount / cell.totalDonations) * 100)
      : 0;

    // Demand intensity: higher if many donations AND high waste rate
    const demandScore = Math.round(
      (cell.totalDonations / daysBack) * 10 + wasteRate * 0.5
    );

    return {
      location: { lat: cell._id.lat, lng: cell._id.lng },
      totalDonations: cell.totalDonations,
      avgDailyDonations: Math.round((cell.totalDonations / daysBack) * 100) / 100,
      avgQuantity: Math.round(cell.avgQuantity),
      wasteRate: `${wasteRate}%`,
      peakHours: peakHour,
      demandScore: Math.min(100, demandScore),
      predictedNeed: demandScore > 15 ? 'HIGH' : demandScore > 8 ? 'MEDIUM' : 'LOW',
    };
  });

  // ── 2. Hourly forecast: when does demand peak? ──
  const hourlyPattern = await Donation.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: { $hour: '$createdAt' },
        count: { $sum: 1 },
        avgQuantity: { $avg: '$quantity' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // Normalize to 24-hour array
  const hourlyForecast = Array.from({ length: 24 }, (_, i) => {
    const found = hourlyPattern.find((h) => h._id === i);
    return {
      hour: i,
      label: `${i.toString().padStart(2, '0')}:00`,
      expectedDonations: found ? Math.round((found.count / daysBack) * 10) / 10 : 0,
      avgQuantity: found ? Math.round(found.avgQuantity) : 0,
    };
  });

  // ── 3. Day-of-week pattern ──
  const weeklyPattern = await Donation.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: { $dayOfWeek: '$createdAt' },
        count: { $sum: 1 },
        avgQuantity: { $avg: '$quantity' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weeklyForecast = weeklyPattern.map((d) => ({
    day: dayNames[d._id - 1],
    avgDonations: Math.round((d.count / (daysBack / 7)) * 10) / 10,
    avgQuantity: Math.round(d.avgQuantity),
  }));

  // ── 4. Trend: is demand increasing or decreasing? ──
  const weeklyTrend = await Donation.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: { $isoWeek: '$createdAt' },
        count: { $sum: 1 },
        totalQuantity: { $sum: '$quantity' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // Simple linear trend: compare last week to average
  let trendDirection = 'STABLE';
  if (weeklyTrend.length >= 2) {
    const recent = weeklyTrend[weeklyTrend.length - 1].count;
    const avg = weeklyTrend.reduce((s, w) => s + w.count, 0) / weeklyTrend.length;
    if (recent > avg * 1.2) trendDirection = 'INCREASING';
    else if (recent < avg * 0.8) trendDirection = 'DECREASING';
  }

  logger.info(`Demand prediction: ${hotspots.length} hotspots, trend=${trendDirection}`);

  return {
    generatedAt: new Date(),
    windowDays: daysBack,
    overallTrend: trendDirection,
    hotspots,
    hourlyForecast,
    weeklyForecast,
    weeklyTrend: weeklyTrend.map((w) => ({
      week: w._id,
      donations: w.count,
      quantity: w.totalQuantity,
    })),
  };
}

module.exports = { predictDemand };
