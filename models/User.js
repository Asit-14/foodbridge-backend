const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { ROLES } = require('../utils/constants');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                      USER MODEL                              ║
 * ║                                                              ║
 * ║  Production-ready user schema with:                          ║
 * ║  - Role-based access (donor, ngo, admin)                     ║
 * ║  - Email verification                                        ║
 * ║  - Password reset functionality                              ║
 * ║  - Account lockout protection                                ║
 * ║  - Geospatial location support                               ║
 * ╚══════════════════════════════════════════════════════════════╝
 */


// ── Constants ──────────────────────────────────────
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME = 2 * 60 * 60 * 1000; // 2 hours
const EMAIL_VERIFY_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_EXPIRY = 60 * 60 * 1000; // 1 hour

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
    // ── Authentication Tokens ──────────────────────────
    refreshToken: {
      type: String,
      select: false,
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
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        delete ret.refreshToken;
        delete ret.emailVerificationToken;
        delete ret.emailVerificationExpires;
        delete ret.passwordResetToken;
        delete ret.passwordResetExpires;
        delete ret.loginAttempts;
        delete ret.lockUntil;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ── Indexes ────────────────────────────────────────
// email index is already created by `unique: true` in the schema field definition
userSchema.index({ role: 1 });
userSchema.index({ location: '2dsphere' });
userSchema.index({ role: 1, isActive: 1, isVerified: 1 }); // matching engine NGO lookup
userSchema.index({ role: 1, isActive: 1, isVerified: 1, citySlug: 1 }); // city-based NGO matching
userSchema.index({ citySlug: 1, role: 1 }); // city analytics
userSchema.index({ stateCode: 1, role: 1 }); // state-level expansion
userSchema.index({ emailVerificationToken: 1 });
userSchema.index({ passwordResetToken: 1 });

// ── Virtual: Check if account is currently locked ──
userSchema.virtual('isLocked').get(function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// ── Pre-save: hash password ───────────────────────
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  
  // Set passwordChangedAt for password changes (not initial creation)
  if (!this.isNew) {
    this.passwordChangedAt = Date.now() - 1000; // Subtract 1s to ensure token issued after change
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

module.exports = mongoose.model('User', userSchema);
