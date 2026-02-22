const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { ROLES } = require('../utils/constants');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                      USER MODEL                              ║
 * ║                                                              ║
 * ║  Production-ready user schema with:                          ║
 * ║  - Role-based access (donor, ngo, admin)                     ║
 * ║  - Email verification (15-min expiry)                        ║
 * ║  - Password reset functionality (15-min expiry)              ║
 * ║  - Account lockout protection (5 attempts / 30 min)          ║
 * ║  - Token version for forced revocation                       ║
 * ║  - TOTP 2FA with encrypted secret and backup codes           ║
 * ║  - Geospatial location support                               ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── Constants ──────────────────────────────────────
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME = 30 * 60 * 1000; // 30 minutes
const EMAIL_VERIFY_EXPIRY = 15 * 60 * 1000; // 15 minutes
const PASSWORD_RESET_EXPIRY = 15 * 60 * 1000; // 15 minutes
const BCRYPT_SALT_ROUNDS = 12;

// ── GeoJSON sub-schema ─────────────────────────────
const pointSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: true,
    },
  },
  { _id: false }
);

// ── User schema ────────────────────────────────────
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: 100,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 8,
      select: false, // never returned in queries by default
    },
    role: {
      type: String,
      enum: ROLES,
      required: [true, 'Role is required'],
    },
    phone: {
      type: String,
      trim: true,
    },
    organizationName: {
      type: String,
      trim: true,
    },
    location: {
      type: pointSchema,
    },
    address: {
      type: String,
      trim: true,
    },
    // ── Structured Location ───────────────────────────
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
      index: true,
    },
    stateCode: {
      type: String,
      trim: true,
      uppercase: true,
    },
    regionCode: {
      type: String,
      trim: true,
      uppercase: true,
    },
    reliabilityScore: {
      type: Number,
      default: 50,
      min: 0,
      max: 100,
    },
    // ── Account Status ─────────────────────────────────
    isVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // ── Token Version (incremented to invalidate all JWTs) ──
    tokenVersion: {
      type: Number,
      default: 0,
    },
    // ── Email Verification ─────────────────────────────
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpires: {
      type: Date,
      select: false,
    },
    // ── Password Reset ─────────────────────────────────
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },
    passwordChangedAt: {
      type: Date,
    },
    // ── Account Lockout (Brute Force Protection) ───────
    loginAttempts: {
      type: Number,
      default: 0,
      select: false,
    },
    lockUntil: {
      type: Date,
      select: false,
    },
    // ── Two-Factor Authentication (TOTP) ───────────────
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    twoFactorSecret: {
      type: String,
      select: false, // encrypted TOTP secret
    },
    backupCodes: {
      type: [String], // hashed backup codes
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        delete ret.emailVerificationToken;
        delete ret.emailVerificationExpires;
        delete ret.passwordResetToken;
        delete ret.passwordResetExpires;
        delete ret.loginAttempts;
        delete ret.lockUntil;
        delete ret.twoFactorSecret;
        delete ret.backupCodes;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ── Indexes ────────────────────────────────────────
userSchema.index({ role: 1 });
userSchema.index({ location: '2dsphere' });
userSchema.index({ role: 1, isActive: 1, isVerified: 1 });
userSchema.index({ role: 1, isActive: 1, isVerified: 1, citySlug: 1 });
userSchema.index({ citySlug: 1, role: 1 });
userSchema.index({ stateCode: 1, role: 1 });
userSchema.index({ emailVerificationToken: 1 });
userSchema.index({ passwordResetToken: 1 });

// ── Virtual: Check if account is currently locked ──
userSchema.virtual('isLocked').get(function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// ── Pre-save: hash password ───────────────────────
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  const salt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
  this.password = await bcrypt.hash(this.password, salt);

  // Set passwordChangedAt for password changes (not initial creation)
  if (!this.isNew) {
    this.passwordChangedAt = Date.now() - 1000;
  }

  next();
});

// ── Instance method: compare passwords ─────────────
userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// ── Instance method: Check if password changed after token issued ──
userSchema.methods.changedPasswordAfter = function (jwtTimestamp) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(this.passwordChangedAt.getTime() / 1000, 10);
    return jwtTimestamp < changedTimestamp;
  }
  return false;
};

// ── Instance method: Generate email verification token ──
userSchema.methods.createEmailVerificationToken = function () {
  const token = crypto.randomBytes(32).toString('hex');

  // Store hashed version in database
  this.emailVerificationToken = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  this.emailVerificationExpires = Date.now() + EMAIL_VERIFY_EXPIRY;

  // Return unhashed token (to be sent via email)
  return token;
};

// ── Instance method: Generate password reset token ──
userSchema.methods.createPasswordResetToken = function () {
  const token = crypto.randomBytes(32).toString('hex');

  // Store hashed version in database
  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  this.passwordResetExpires = Date.now() + PASSWORD_RESET_EXPIRY;

  // Return unhashed token (to be sent via email)
  return token;
};

// ── Instance method: Increment login attempts ──────
userSchema.methods.incLoginAttempts = async function () {
  // Reset if lock has expired
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $set: { loginAttempts: 1 },
      $unset: { lockUntil: 1 },
    });
  }

  const updates = { $inc: { loginAttempts: 1 } };

  // Lock account if max attempts reached
  if (this.loginAttempts + 1 >= MAX_LOGIN_ATTEMPTS && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + LOCK_TIME };
  }

  return this.updateOne(updates);
};

// ── Instance method: Reset login attempts on successful login ──
userSchema.methods.resetLoginAttempts = function () {
  return this.updateOne({
    $set: { loginAttempts: 0 },
    $unset: { lockUntil: 1 },
  });
};

// ── Instance method: Increment token version (force-revoke all JWTs) ──
userSchema.methods.incrementTokenVersion = function () {
  this.tokenVersion = (this.tokenVersion || 0) + 1;
  return this.save({ validateBeforeSave: false });
};

// ── Static method: Find user by verification token ──
userSchema.statics.findByVerificationToken = function (token) {
  const hashedToken = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  return this.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpires: { $gt: Date.now() },
  });
};

// ── Static method: Find user by reset token ────────
userSchema.statics.findByResetToken = function (token) {
  const hashedToken = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  return this.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });
};

// ── Export constants for external use ──────────────
userSchema.statics.MAX_LOGIN_ATTEMPTS = MAX_LOGIN_ATTEMPTS;
userSchema.statics.LOCK_TIME = LOCK_TIME;
userSchema.statics.EMAIL_VERIFY_EXPIRY = EMAIL_VERIFY_EXPIRY;
userSchema.statics.PASSWORD_RESET_EXPIRY = PASSWORD_RESET_EXPIRY;

module.exports = mongoose.model('User', userSchema);
