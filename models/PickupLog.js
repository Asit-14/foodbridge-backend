const mongoose = require('mongoose');
const { PICKUP_STATUSES } = require('../utils/constants');

const pickupLogSchema = new mongoose.Schema(
  {
    donationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Donation',
      required: true,
      index: true,
    },
    ngoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    donorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // ── Timeline ──
    acceptedAt: {
      type: Date,
      default: Date.now,
    },
    pickupTime: {
      type: Date,
      default: null,
    },
    deliveryTime: {
      type: Date,
      default: null,
    },

    // ── Verification ──
    pickupOTP: {
      type: String,
      select: false,
    },
    otpVerified: {
      type: Boolean,
      default: false,
    },

    // ── Delivery details ──
    beneficiaryCount: {
      type: Number,
      default: 0,
    },
    deliveryNotes: {
      type: String,
      trim: true,
    },

    status: {
      type: String,
      enum: PICKUP_STATUSES,
      default: 'in_progress',
      index: true,
    },

    failureReason: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

pickupLogSchema.index({ ngoId: 1, status: 1 });
pickupLogSchema.index({ createdAt: -1 });
pickupLogSchema.index({ donationId: 1, ngoId: 1, status: 1 }); // pickup lookup
pickupLogSchema.index({ ngoId: 1, createdAt: -1 });             // reliability engine

module.exports = mongoose.model('PickupLog', pickupLogSchema);
