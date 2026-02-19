const mongoose = require('mongoose');

const STATUSES = ['Available', 'Accepted', 'PickedUp', 'Delivered', 'Expired', 'Cancelled'];

const FOOD_CATEGORIES = [
  'cooked_meal',
  'raw_ingredients',
  'packaged',
  'bakery',
  'beverages',
  'mixed',
];

// ── Category-specific max shelf life (hours) ───────
const SHELF_LIFE = {
  cooked_meal: 6,
  raw_ingredients: 24,
  packaged: 48,
  bakery: 12,
  beverages: 24,
  mixed: 6,
};

// ── GeoJSON Point ──────────────────────────────────
const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true },
  },
  { _id: false }
);

// ── Donation schema ────────────────────────────────
const donationSchema = new mongoose.Schema(
  {
    donorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // ── Food details ──
    foodType: {
      type: String,
      required: [true, 'Food type is required'],
      trim: true,
    },
    category: {
      type: String,
      enum: FOOD_CATEGORIES,
      default: 'cooked_meal',
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [1, 'Quantity must be at least 1'],
    },
    unit: {
      type: String,
      enum: ['servings', 'kg', 'packets', 'trays'],
      default: 'servings',
    },
    images: [{ type: String }],

    // ── Timing ──
    preparedAt: {
      type: Date,
      default: Date.now,
    },
    expiryTime: {
      type: Date,
      required: [true, 'Expiry time is required'],
    },
    pickupDeadline: {
      type: Date,
      required: [true, 'Pickup deadline is required'],
    },

    // ── Location ──
    location: {
      type: pointSchema,
      required: true,
    },
    pickupAddress: {
      type: String,
      required: [true, 'Pickup address is required'],
      trim: true,
    },
    contactPhone: {
      type: String,
      trim: true,
    },
    specialInstructions: {
      type: String,
      trim: true,
      maxlength: 300,
    },

    // ── Lifecycle ──
    status: {
      type: String,
      enum: STATUSES,
      default: 'Available',
      index: true,
    },
    acceptedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    pickedUpAt: {
      type: Date,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },

    // ── Matching ──
    priorityScore: {
      type: Number,
      default: 0,
    },
    reassignCount: {
      type: Number,
      default: 0,
    },
    reassignHistory: [
      {
        ngoId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        acceptedAt: Date,
        expiredAt: Date,
        reason: String,
      },
    ],

    // ── Feedback ──
    feedbackRating: { type: Number, min: 1, max: 5 },
    feedbackNote: { type: String, trim: true },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ────────────────────────────────────────
donationSchema.index({ location: '2dsphere' });
donationSchema.index({ status: 1, expiryTime: 1 });
donationSchema.index({ donorId: 1, status: 1 });
donationSchema.index({ acceptedBy: 1, status: 1 });
donationSchema.index({ createdAt: -1 });
donationSchema.index({ status: 1, createdAt: -1 });      // heatmap & trend queries
donationSchema.index({ category: 1, status: 1 });         // category analytics

// ── Virtual: is expired ───────────────────────────
donationSchema.virtual('isExpired').get(function () {
  return this.expiryTime < new Date();
});

// ── Instance: safe expiry validation ──────────────
donationSchema.methods.validateExpiry = function () {
  const now = new Date();
  const minWindow = new Date(now.getTime() + 30 * 60 * 1000); // +30 min

  if (this.expiryTime <= minWindow) {
    return { valid: false, reason: 'Expiry must be at least 30 minutes from now' };
  }

  // Category-specific max shelf life
  const maxHours = SHELF_LIFE[this.category] || 6;
  const maxExpiry = new Date(this.preparedAt.getTime() + maxHours * 3600 * 1000);

  if (this.expiryTime > maxExpiry) {
    return {
      valid: false,
      reason: `${this.category} cannot exceed ${maxHours}h shelf life`,
    };
  }

  if (this.pickupDeadline > this.expiryTime) {
    return { valid: false, reason: 'Pickup deadline cannot be after expiry' };
  }

  return { valid: true };
};

// ── Static: valid status transitions ──────────────
const VALID_TRANSITIONS = {
  Available: ['Accepted', 'Expired', 'Cancelled'],
  Accepted: ['PickedUp', 'Available', 'Expired'],  // Available = reassign
  PickedUp: ['Delivered'],
  Delivered: [],
  Expired: [],
  Cancelled: [],
};

donationSchema.methods.canTransitionTo = function (newStatus) {
  return VALID_TRANSITIONS[this.status]?.includes(newStatus) || false;
};

module.exports = mongoose.model('Donation', donationSchema);
module.exports.STATUSES = STATUSES;
module.exports.VALID_TRANSITIONS = VALID_TRANSITIONS;
