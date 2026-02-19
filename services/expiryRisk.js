const logger = require('../utils/logger');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          EXPIRY RISK INTELLIGENCE                           ║
 * ║                                                             ║
 * ║  Estimates food safety risk based on:                       ║
 * ║    1. Category-specific spoilage rate                       ║
 * ║    2. Time elapsed since preparation                        ║
 * ║    3. Remaining shelf life percentage                       ║
 * ║    4. Estimated transport time (distance-based)             ║
 * ║    5. Time-of-day temperature heuristic                     ║
 * ║                                                             ║
 * ║  Output: { riskLevel, riskScore, factors, recommendation }  ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── Spoilage rate constants (0–1 scale, higher = spoils faster) ──
const SPOILAGE_RATE = {
  cooked_meal:     0.85,
  raw_ingredients: 0.45,
  packaged:        0.15,
  bakery:          0.65,
  beverages:       0.20,
  mixed:           0.75,
};

// ── Max safe shelf life in hours ──
const MAX_SHELF_HOURS = {
  cooked_meal:     6,
  raw_ingredients: 24,
  packaged:        48,
  bakery:          12,
  beverages:       24,
  mixed:           6,
};

/**
 * Calculate the food safety risk score for a donation.
 *
 * @param {Object} donation         Mongoose donation document (or plain obj)
 * @param {number} [transportKm]    Estimated transport distance in km
 * @returns {Object}  { riskScore, riskLevel, color, factors, recommendation }
 */
function assessExpiryRisk(donation, transportKm = 0) {
  const now = Date.now();
  const preparedAt = new Date(donation.preparedAt).getTime();
  const expiresAt = new Date(donation.expiryTime).getTime();
  const category = donation.category || 'cooked_meal';

  // ── Factor 1: Time elapsed (% of shelf life consumed) ──
  const totalShelfMs = MAX_SHELF_HOURS[category] * 3600 * 1000;
  const elapsedMs = now - preparedAt;
  const shelfUsedPct = Math.min(100, (elapsedMs / totalShelfMs) * 100);

  // ── Factor 2: Remaining time before expiry ──
  const remainingMs = expiresAt - now;
  const remainingMins = remainingMs / 60000;
  let timeRisk;
  if (remainingMins <= 0) timeRisk = 100;
  else if (remainingMins <= 15) timeRisk = 95;
  else if (remainingMins <= 30) timeRisk = 80;
  else if (remainingMins <= 60) timeRisk = 55;
  else if (remainingMins <= 120) timeRisk = 30;
  else timeRisk = 10;

  // ── Factor 3: Category spoilage sensitivity ──
  const spoilageRisk = SPOILAGE_RATE[category] * 100;

  // ── Factor 4: Transport time estimate ──
  // Assume 20 km/h average pickup speed (urban)
  const transportMins = transportKm > 0 ? (transportKm / 20) * 60 : 0;
  let transportRisk = 0;
  if (transportMins > 30) transportRisk = 70;
  else if (transportMins > 15) transportRisk = 40;
  else if (transportMins > 5) transportRisk = 15;

  // Will food expire during transport?
  if (transportMins > 0 && remainingMins > 0 && transportMins >= remainingMins * 0.8) {
    transportRisk = Math.max(transportRisk, 85);
  }

  // ── Factor 5: Temperature sensitivity (time-of-day heuristic) ──
  const hour = new Date().getHours();
  let tempRisk = 20; // default moderate
  // Hot afternoon (11 AM – 4 PM in tropical climates)
  if (hour >= 11 && hour <= 16) {
    tempRisk = category === 'cooked_meal' || category === 'bakery' ? 70 : 40;
  }
  // Cool morning/night
  if (hour <= 6 || hour >= 21) {
    tempRisk = 10;
  }

  // ── Composite risk score (weighted) ──
  const riskScore = Math.round(
    0.30 * shelfUsedPct +
    0.30 * timeRisk +
    0.15 * spoilageRisk +
    0.15 * transportRisk +
    0.10 * tempRisk
  );

  // ── Classify into levels ──
  let riskLevel, color, recommendation;
  if (riskScore >= 70) {
    riskLevel = 'HIGH';
    color = 'red';
    recommendation = 'Immediate pickup required. Consider reducing pickup radius. Not safe for extended transport.';
  } else if (riskScore >= 40) {
    riskLevel = 'MEDIUM';
    color = 'amber';
    recommendation = 'Pickup within 30 minutes recommended. Ensure proper handling during transport.';
  } else {
    riskLevel = 'LOW';
    color = 'green';
    recommendation = 'Food is safe for standard pickup and delivery window.';
  }

  const result = {
    riskScore,
    riskLevel,
    color,
    recommendation,
    factors: {
      shelfLifeUsed: `${Math.round(shelfUsedPct)}%`,
      timeRemaining: `${Math.round(remainingMins)} min`,
      categoryRisk: `${category} (${Math.round(spoilageRisk)}%)`,
      transportEstimate: `${Math.round(transportMins)} min (${transportKm.toFixed(1)} km)`,
      temperatureRisk: `${tempRisk}% (hour: ${hour})`,
    },
  };

  logger.debug(
    `Expiry risk: donation ${donation._id} → ${riskLevel} (${riskScore}/100)`
  );

  return result;
}

module.exports = { assessExpiryRisk };
