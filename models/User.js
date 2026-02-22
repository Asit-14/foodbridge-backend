const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const { ROLES } = require('../utils/constants');

const BCRYPT_SALT_ROUNDS = 10;

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
      select: false,
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
    isVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
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

// ── Pre-save: hash password ───────────────────────
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ── Instance method: compare passwords ─────────────
userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('User', userSchema);
