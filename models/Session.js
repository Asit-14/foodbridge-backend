const mongoose = require('mongoose');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                    SESSION MODEL                              ║
 * ║                                                              ║
 * ║  Stores hashed refresh tokens for multi-device login.        ║
 * ║  Each document = one active session on one device.           ║
 * ║                                                              ║
 * ║  Security features:                                          ║
 * ║  - Refresh tokens stored as SHA-256 hashes                   ║
 * ║  - TTL index auto-deletes expired sessions                   ║
 * ║  - Token family tracking for reuse detection                 ║
 * ║  - Device/IP metadata for session management UI              ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const sessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    hashedToken: {
      type: String,
      required: true,
    },
    // Token family ID — all rotated tokens in one session share this.
    // If a token outside the current family is presented, it signals reuse.
    family: {
      type: String,
      required: true,
      index: true,
    },
    deviceInfo: {
      type: String,
      default: 'Unknown device',
    },
    ipAddress: {
      type: String,
      default: '',
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
    // Marks this session as revoked (soft-delete for audit trail)
    isRevoked: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// TTL index: MongoDB auto-deletes documents when expiresAt passes
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound index for fast lookups during refresh
sessionSchema.index({ userId: 1, family: 1 });

// Compound index for refresh token lookup (covers findOneAndUpdate in refresh handler)
sessionSchema.index({ userId: 1, hashedToken: 1 });

// Clean up revoked sessions older than 24h (keep recent ones for audit)
sessionSchema.index(
  { isRevoked: 1, updatedAt: 1 },
  { expireAfterSeconds: 86400, partialFilterExpression: { isRevoked: true } }
);

/**
 * Revoke all sessions for a user (logout-all / password change)
 */
sessionSchema.statics.revokeAllForUser = async function (userId) {
  return this.updateMany(
    { userId, isRevoked: false },
    { $set: { isRevoked: true } }
  );
};

/**
 * Revoke all sessions in a token family (reuse detection)
 */
sessionSchema.statics.revokeFamily = async function (family) {
  return this.updateMany(
    { family, isRevoked: false },
    { $set: { isRevoked: true } }
  );
};

/**
 * Count active sessions for a user
 */
sessionSchema.statics.countActiveSessions = async function (userId) {
  return this.countDocuments({
    userId,
    isRevoked: false,
    expiresAt: { $gt: new Date() },
  });
};

/**
 * Get all active sessions for a user (session management UI)
 */
sessionSchema.statics.getActiveSessions = async function (userId) {
  return this.find({
    userId,
    isRevoked: false,
    expiresAt: { $gt: new Date() },
  })
    .select('deviceInfo ipAddress createdAt lastUsedAt')
    .sort({ lastUsedAt: -1 });
};

module.exports = mongoose.model('Session', sessionSchema);
