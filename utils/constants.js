/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                  CENTRALIZED CONSTANTS                       ║
 * ║                                                              ║
 * ║  Single source of truth for all enums, statuses, config.    ║
 * ║  Import from here — never define magic strings inline.      ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── Donation Status Lifecycle ─────────────────────
const STATUS = Object.freeze({
  AVAILABLE: 'Available',
  ACCEPTED: 'Accepted',
  PICKED_UP: 'PickedUp',
  DELIVERED: 'Delivered',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
});

const DONATION_STATUSES = Object.freeze(Object.values(STATUS));

// ── Valid Status Transitions ──────────────────────
const VALID_TRANSITIONS = Object.freeze({
  [STATUS.AVAILABLE]: [STATUS.ACCEPTED, STATUS.EXPIRED, STATUS.CANCELLED],
  [STATUS.ACCEPTED]:  [STATUS.PICKED_UP, STATUS.AVAILABLE, STATUS.EXPIRED],
  [STATUS.PICKED_UP]: [STATUS.DELIVERED],
  [STATUS.DELIVERED]: [],
  [STATUS.EXPIRED]:   [],
  [STATUS.CANCELLED]: [],
});

// ── User Roles ────────────────────────────────────
const ROLE = Object.freeze({
  DONOR: 'donor',
  NGO: 'ngo',
  ADMIN: 'admin',
});

const ROLES = Object.freeze(Object.values(ROLE));

// ── Food Categories ──────────────────────────────
const FOOD_CATEGORIES = Object.freeze([
  'cooked_meal',
  'raw_ingredients',
  'packaged',
  'bakery',
  'beverages',
  'mixed',
]);

// ── Category-specific max shelf life (hours) ──────
const SHELF_LIFE = Object.freeze({
  cooked_meal: 6,
  raw_ingredients: 24,
  packaged: 48,
  bakery: 12,
  beverages: 24,
  mixed: 6,
});

// ── Donation Units ────────────────────────────────
const UNITS = Object.freeze(['servings', 'kg', 'packets', 'trays']);

// ── PickupLog Statuses ───────────────────────────
const PICKUP_STATUS = Object.freeze({
  IN_PROGRESS: 'in_progress',
  PICKED_UP: 'picked_up',
  DELIVERED: 'delivered',
  FAILED: 'failed',
});

const PICKUP_STATUSES = Object.freeze(Object.values(PICKUP_STATUS));

// ── Notification Types ───────────────────────────
const NOTIFICATION_TYPES = Object.freeze([
  'new_donation_nearby',
  'donation_accepted',
  'pickup_confirmed',
  'delivery_confirmed',
  'donation_expired',
  'donation_reassigned',
  'ngo_verified',
  'system_alert',
]);

// ── Geo Defaults ─────────────────────────────────
const DEFAULT_MAP_CENTER = Object.freeze({ lat: 28.6139, lng: 77.209 });
const DEFAULT_SEARCH_RADIUS_KM = 5;

// ── Matching Engine ──────────────────────────────
const SEARCH_RADIUS_KM = 10;
const EXPANDED_RADIUS_KM = 25;
const MAX_REASSIGN_ATTEMPTS = 3;
const STALE_PICKUP_WINDOW_MS = 20 * 60 * 1000; // 20 minutes
const MAX_DAILY_PICKUPS = 10;

module.exports = {
  STATUS,
  DONATION_STATUSES,
  VALID_TRANSITIONS,
  ROLE,
  ROLES,
  FOOD_CATEGORIES,
  SHELF_LIFE,
  UNITS,
  PICKUP_STATUS,
  PICKUP_STATUSES,
  NOTIFICATION_TYPES,
  DEFAULT_MAP_CENTER,
  DEFAULT_SEARCH_RADIUS_KM,
  SEARCH_RADIUS_KM,
  EXPANDED_RADIUS_KM,
  MAX_REASSIGN_ATTEMPTS,
  STALE_PICKUP_WINDOW_MS,
  MAX_DAILY_PICKUPS,
};
