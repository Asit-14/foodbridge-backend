const mongoose = require('mongoose');
const { NOTIFICATION_TYPES } = require('../utils/constants');


const notificationSchema = new mongoose.Schema(
  {
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    data: {
      donationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Donation' },
      link: String,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ── Compound index for typical query: user's unread, newest first ──
notificationSchema.index({ recipientId: 1, isRead: 1, createdAt: -1 });

// ── TTL: auto-delete after 30 days ──
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

module.exports = mongoose.model('Notification', notificationSchema);
