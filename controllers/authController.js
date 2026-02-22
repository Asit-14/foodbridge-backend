const User = require('../models/User');
const {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
} = require('../utils/AppError');
const catchAsync = require('../utils/catchAsync');
const { signAccessToken } = require('../utils/jwtUtils');
const { ROLE } = require('../utils/constants');

/**
 * POST /api/v1/auth/register
 * Create a new user account and issue a JWT.
 */
exports.register = catchAsync(async (req, res, next) => {
  const {
    name, email, password, role, phone, organizationName,
    location, address, city, state, country, citySlug, stateCode, regionCode,
  } = req.body;

  if (role === ROLE.ADMIN) {
    return next(new AuthorizationError('Admin accounts cannot be self-registered.'));
  }

  const existing = await User.findOne({ email });
  if (existing) {
    return next(new ConflictError('An account with this email already exists.'));
  }

  const user = await User.create({
    name, email, password, role, phone, organizationName,
    location, address,
    city, state, country: country || 'India',
    citySlug, stateCode, regionCode,
    isVerified: role === ROLE.DONOR,
  });

  const token = signAccessToken(user);

  res.status(201).json({
    success: true,
    token,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});

/**
 * POST /api/v1/auth/login
 * Authenticate with email and password, return JWT.
 */
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password');

  if (!user) {
    return next(new NotFoundError('Please register first.'));
  }

  if (!user.isActive) {
    return next(new AuthorizationError('Account has been deactivated. Contact support.'));
  }

  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    return next(new AuthenticationError('Invalid credentials.'));
  }

  const token = signAccessToken(user);

  res.status(200).json({
    success: true,
    token,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});

/**
 * GET /api/v1/auth/me
 * Return the currently authenticated user.
 */
exports.getMe = catchAsync(async (req, res) => {
  res.status(200).json({
    success: true,
    data: { user: req.user },
  });
});

/**
 * POST /api/v1/auth/logout
 * Client-side logout — server acknowledges.
 */
exports.logout = catchAsync(async (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'Logged out successfully.',
  });
});

/**
 * PUT /api/v1/auth/profile
 * Update user profile (safe fields only).
 */
exports.updateProfile = catchAsync(async (req, res) => {
  const allowedFields = [
    'name', 'phone', 'organizationName', 'location', 'address',
    'city', 'state', 'country', 'citySlug', 'stateCode', 'regionCode',
  ];
  const updates = {};

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  const user = await User.findByIdAndUpdate(req.user._id, updates, {
    new: true,
    runValidators: true,
  });

  res.status(200).json({
    success: true,
    data: { user },
  });
});
