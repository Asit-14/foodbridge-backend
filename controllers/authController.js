const User = require('../models/User');
const AppError = require('../utils/AppError');
const catchAsync = require('../utils/catchAsync');
const env = require('../config/env');
const logger = require('../utils/logger');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
  compareRefreshToken,
  getRefreshTokenCookieOptions,
} = require('../utils/jwtUtils');
const {
  sendWelcomeEmail,
  sendEmailVerification,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
} = require('../services/emailService');
const ERRORS = require('../utils/errorMessages');
const { ROLE } = require('../utils/constants');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              AUTHENTICATION CONTROLLER                        ║
 * ║                                                              ║
 * ║  Production-ready authentication with:                       ║
 * ║  - JWT access/refresh tokens                                 ║
 * ║  - Email verification                                        ║
 * ║  - Password reset flow                                       ║
 * ║  - Account lockout protection                                ║
 * ║  - Secure cookie handling                                    ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── Token Response Helper ──────────────────────────

/**
 * Generate tokens and send response with secure cookie
 * @param {Object} user - User document
 * @param {number} statusCode - HTTP status code
 * @param {Object} res - Express response object
 * @param {Object} options - Additional options
 */
async function sendTokenResponse(user, statusCode, res, options = {}) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  // Hash refresh token before storing in DB
  const hashedRefreshToken = hashRefreshToken(refreshToken);
  await User.findByIdAndUpdate(user._id, { 
    refreshToken: hashedRefreshToken,
    // Reset login attempts on successful auth
    loginAttempts: 0,
    $unset: { lockUntil: 1 },
  });

  // Set refresh token as httpOnly cookie
  res.cookie('refreshToken', refreshToken, getRefreshTokenCookieOptions());

  // Prepare response data
  const responseData = {
    status: 'success',
    accessToken,
    data: { user },
  };

  // Include additional message if provided
  if (options.message) {
    responseData.message = options.message;
  }

  res.status(statusCode).json(responseData);
}

// ── Controllers ────────────────────────────────────

/**
 * POST /api/v1/auth/register
 * Register a new user with email verification
 */
exports.register = catchAsync(async (req, res, next) => {
  const {
    name,
    email,
    password,
    role,
    phone,
    organizationName,
    location,
    address,
    city,
    state,
    country,
    citySlug,
    stateCode,
    regionCode,
  } = req.body;

  // Prevent self-registration as admin
  if (role === ROLE.ADMIN) {
    return next(new AppError(ERRORS.ADMIN_SELF_REGISTER, 403));
  }

  // Check if user already exists
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return next(new AppError(ERRORS.EMAIL_EXISTS, 409));
  }

  // Create user
  const user = await User.create({
    name,
    email,
    password,
    role,
    phone,
    organizationName,
    location,
    address,
    city,
    state,
    country: country || 'India',
    citySlug,
    stateCode,
    regionCode,
    isVerified: role === ROLE.DONOR, // NGOs need admin verification
    isEmailVerified: false,
  });

  // Generate email verification token
  const verificationToken = user.createEmailVerificationToken();
  await user.save({ validateBeforeSave: false });

  // Send verification email
  try {
    const verificationUrl = `${env.client.url}/verify-email/${verificationToken}`;
    await sendEmailVerification(user, verificationUrl);
    
    logger.info(`Registration: Verification email sent to ${user.email}`);
  } catch (err) {
    // Don't fail registration if email fails - user can request resend
    logger.error(`Registration: Failed to send verification email - ${err.message}`);
  }

  // Send welcome email (non-blocking)
  sendWelcomeEmail(user).catch((err) => logger.error('Email send failed:', err.message));

  // Don't auto-login, require email verification first
  res.status(201).json({
    status: 'success',
    message: 'Registration successful. Please check your email to verify your account.',
    data: {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    },
  });
});

/**
 * POST /api/v1/auth/login
 * Login with email and password
 */
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  // Fetch user with password and security fields
  const user = await User.findOne({ email }).select(
    '+password +loginAttempts +lockUntil +refreshToken'
  );

  // Check if user exists
  if (!user) {
    return next(new AppError(ERRORS.INVALID_CREDENTIALS, 401));
  }

  // Check if account is locked
  if (user.isLocked) {
    const lockRemaining = Math.ceil((user.lockUntil - Date.now()) / 60000);
    return next(
      new AppError(
        `Account is temporarily locked. Try again in ${lockRemaining} minutes.`,
        423
      )
    );
  }

  // Verify password
  const isPasswordValid = await user.comparePassword(password);
  
  if (!isPasswordValid) {
    // Increment failed login attempts
    await user.incLoginAttempts();
    
    const attemptsRemaining = User.MAX_LOGIN_ATTEMPTS - (user.loginAttempts + 1);
    
    if (attemptsRemaining <= 0) {
      logger.warn(`Login: Account locked for ${email} after ${User.MAX_LOGIN_ATTEMPTS} failed attempts`);
      return next(
        new AppError(ERRORS.ACCOUNT_LOCKED_ATTEMPTS, 423)
      );
    }
    
    return next(
      new AppError(
        `Invalid email or password. ${attemptsRemaining} attempts remaining.`,
        401
      )
    );
  }

  // Check if account is active
  if (!user.isActive) {
    return next(new AppError(ERRORS.ACCOUNT_DEACTIVATED, 403));
  }

  // Check email verification (optional - can be made required)
  if (!user.isEmailVerified && env.isProd) {
    return next(
      new AppError(ERRORS.EMAIL_NOT_VERIFIED, 403)
    );
  }

  // Successful login
  logger.info(`Login: Successful login for ${email}`);
  await sendTokenResponse(user, 200, res);
});

/**
 * POST /api/v1/auth/verify-email/:token
 * Verify email address
 */
exports.verifyEmail = catchAsync(async (req, res, next) => {
  const { token } = req.params;

  // Find user by verification token
  const user = await User.findByVerificationToken(token);

  if (!user) {
    return next(
      new AppError(ERRORS.INVALID_VERIFY_TOKEN, 400)
    );
  }

  // Mark email as verified
  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save({ validateBeforeSave: false });

  logger.info(`Email verified for ${user.email}`);

  res.status(200).json({
    status: 'success',
    message: 'Email verified successfully. You can now log in.',
  });
});

/**
 * POST /api/v1/auth/resend-verification
 * Resend email verification link
 */
exports.resendVerification = catchAsync(async (req, res, next) => {
  const { email } = req.body;

  const user = await User.findOne({ email });

  // Don't reveal if email exists
  if (!user) {
    return res.status(200).json({
      status: 'success',
      message: 'If an account exists, a verification email will be sent.',
    });
  }

  // Check if already verified
  if (user.isEmailVerified) {
    return res.status(200).json({
      status: 'success',
      message: 'Email is already verified.',
    });
  }

  // Generate new verification token
  const verificationToken = user.createEmailVerificationToken();
  await user.save({ validateBeforeSave: false });

  // Send verification email
  try {
    const verificationUrl = `${env.client.url}/verify-email/${verificationToken}`;
    await sendEmailVerification(user, verificationUrl);
  } catch (err) {
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save({ validateBeforeSave: false });
    
    return next(new AppError(ERRORS.VERIFY_EMAIL_FAILED, 500));
  }

  res.status(200).json({
    status: 'success',
    message: 'If an account exists, a verification email will be sent.',
  });
});

/**
 * POST /api/v1/auth/refresh-token
 * Get new access token using refresh token
 */
exports.refreshToken = catchAsync(async (req, res, next) => {
  const token = req.cookies?.refreshToken;
  
  if (!token) {
    return next(new AppError(ERRORS.NO_REFRESH_TOKEN, 401));
  }

  // Verify refresh token
  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch (err) {
    return next(new AppError(ERRORS.INVALID_REFRESH_TOKEN, 401));
  }

  // Find user and verify stored refresh token
  const user = await User.findById(decoded.id).select('+refreshToken');
  
  if (!user) {
    return next(new AppError(ERRORS.USER_NOT_EXISTS, 401));
  }

  if (!user.refreshToken) {
    return next(new AppError(ERRORS.RELOGIN_REQUIRED, 401));
  }

  // Compare hashed tokens
  const isValidToken = compareRefreshToken(token, user.refreshToken);
  if (!isValidToken) {
    // Possible token reuse attack - invalidate all tokens
    await User.findByIdAndUpdate(user._id, { refreshToken: null });
    logger.warn(`Security: Refresh token mismatch for user ${user.email} - possible token reuse`);
    return next(new AppError(ERRORS.TOKEN_REUSE, 401));
  }

  // Check if user is still active
  if (!user.isActive) {
    return next(new AppError('Account has been deactivated.', 403));
  }

  // Issue new token pair (token rotation)
  await sendTokenResponse(user, 200, res);
});

/**
 * POST /api/v1/auth/forgot-password
 * Request password reset email
 */
exports.forgotPassword = catchAsync(async (req, res, next) => {
  const { email } = req.body;

  const user = await User.findOne({ email });

  // Always return success to prevent email enumeration
  const successMessage = 'If an account exists with this email, a password reset link will be sent.';

  if (!user) {
    return res.status(200).json({
      status: 'success',
      message: successMessage,
    });
  }

  // Generate password reset token
  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  // Send password reset email
  try {
    const resetUrl = `${env.client.url}/reset-password/${resetToken}`;
    await sendPasswordResetEmail(user, resetUrl);
    
    logger.info(`Password reset requested for ${email}`);
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });
    
    logger.error(`Failed to send password reset email: ${err.message}`);
    return next(new AppError('Failed to send reset email. Try again later.', 500));
  }

  res.status(200).json({
    status: 'success',
    message: successMessage,
  });
});

/**
 * POST /api/v1/auth/reset-password/:token
 * Reset password using token
 */
exports.resetPassword = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const { password } = req.body;

  // Find user by reset token
  const user = await User.findByResetToken(token);

  if (!user) {
    return next(new AppError('Invalid or expired password reset token.', 400));
  }

  // Update password
  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  
  // Invalidate all existing sessions
  user.refreshToken = undefined;
  
  await user.save();

  // Send confirmation email
  sendPasswordChangedEmail(user).catch((err) => logger.error('Email send failed:', err.message));

  logger.info(`Password reset completed for ${user.email}`);

  res.status(200).json({
    status: 'success',
    message: 'Password reset successful. Please log in with your new password.',
  });
});

/**
 * POST /api/v1/auth/change-password
 * Change password (logged-in user)
 */
exports.changePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  // Get user with password
  const user = await User.findById(req.user._id).select('+password');

  // Verify current password
  const isCurrentPasswordValid = await user.comparePassword(currentPassword);
  if (!isCurrentPasswordValid) {
    return next(new AppError(ERRORS.CURRENT_PASSWORD_WRONG, 401));
  }

  // Prevent using same password
  const isSamePassword = await user.comparePassword(newPassword);
  if (isSamePassword) {
    return next(new AppError(ERRORS.SAME_PASSWORD, 400));
  }

  // Update password
  user.password = newPassword;
  await user.save();

  // Invalidate all other sessions by clearing refresh token
  // Then issue new tokens for current session
  await sendTokenResponse(user, 200, res, {
    message: 'Password changed successfully.',
  });

  // Send notification email
  sendPasswordChangedEmail(user).catch((err) => logger.error('Email send failed:', err.message));

  logger.info(`Password changed for ${user.email}`);
});

/**
 * POST /api/v1/auth/logout
 * Logout - invalidate refresh token
 */
exports.logout = catchAsync(async (req, res) => {
  // Clear refresh token from database
  await User.findByIdAndUpdate(req.user._id, { refreshToken: null });

  // Clear cookie
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'strict' : 'lax',
    path: '/api/v1/auth',
  });

  logger.info(`Logout: ${req.user.email}`);

  res.status(200).json({
    status: 'success',
    message: 'Logged out successfully.',
  });
});

/**
 * POST /api/v1/auth/logout-all
 * Logout from all devices
 */
exports.logoutAll = catchAsync(async (req, res) => {
  // Clear all refresh tokens
  await User.findByIdAndUpdate(req.user._id, { 
    refreshToken: null,
    passwordChangedAt: Date.now(),
  });

  // Clear cookie
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'strict' : 'lax',
    path: '/api/v1/auth',
  });

  logger.info(`Logout all sessions: ${req.user.email}`);

  res.status(200).json({
    status: 'success',
    message: 'Logged out from all devices.',
  });
});

/**
 * GET /api/v1/auth/me
 * Get current user profile
 */
exports.getMe = catchAsync(async (req, res) => {
  res.status(200).json({
    status: 'success',
    data: { user: req.user },
  });
});

/**
 * PUT /api/v1/auth/profile
 * Update user profile
 */
exports.updateProfile = catchAsync(async (req, res) => {
  const allowedFields = ['name', 'phone', 'organizationName', 'location', 'address', 'city', 'state', 'country', 'citySlug', 'stateCode', 'regionCode'];
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
    status: 'success',
    data: { user },
  });
});

/**
 * GET /api/v1/auth/sessions
 * Get active session info (for account security page)
 */
exports.getSessions = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select('+refreshToken');
  
  const hasActiveSessions = !!user.refreshToken;

  res.status(200).json({
    status: 'success',
    data: {
      hasActiveSessions,
      lastLogin: user.updatedAt,
    },
  });
});
