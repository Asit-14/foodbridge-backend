const mongoose = require('mongoose');
const { DONATION_STATUSES, FOOD_CATEGORIES, SHELF_LIFE, VALID_TRANSITIONS } = require('../utils/constants');

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

    // ── Structured Location ──
    city: {
      type: String,
      trim: true,
    },
    state: {
      type: String,
      trim: true,
    },
    country: {
      type: String,
      trim: true,
      default: 'India',
    },
    citySlug: {
      type: String,
      trim: true,
      lowercase: true,
    },
    stateCode: {
      type: String,
      trim: true,
      uppercase: true,
    },

    // ── Lifecycle ──
    status: {
      type: String,
      enum: DONATION_STATUSES,
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
donationSchema.index({ citySlug: 1, status: 1 });          // city-based filtering
donationSchema.index({ stateCode: 1, status: 1 });         // state-level analytics
donationSchema.index({ citySlug: 1, status: 1, createdAt: -1 }); // city analytics with time
donationSchema.index({ 'reassignHistory.ngoId': 1 });

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


donationSchema.methods.canTransitionTo = function (newStatus) {
  return VALID_TRANSITIONS[this.status]?.includes(newStatus) || false;
};

module.exports = mongoose.model('Donation', donationSchema);
module.exports.STATUSES = DONATION_STATUSES;
module.exports.VALID_TRANSITIONS = VALID_TRANSITIONS;
