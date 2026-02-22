const crypto = require('crypto');
const User = require('../models/User');
const Session = require('../models/Session');
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
  getTokenExpiries,
} = require('../utils/jwtUtils');
const {
  sendWelcomeEmail,
  sendEmailVerification,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountLockedEmail,
} = require('../services/emailService');
const {
  generateCsrfToken,
  setCsrfCookie,
} = require('../middleware/csrf');
const {
  generateTOTPSecret,
  verifyTOTP,
  generateBackupCodes,
  verifyBackupCode,
} = require('../utils/twoFactorAuth');
const ERRORS = require('../utils/errorMessages');
const { ROLE } = require('../utils/constants');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              AUTHENTICATION CONTROLLER                        ║
 * ║                                                              ║
 * ║  Production-grade authentication with:                       ║
 * ║  - JWT access/refresh tokens with rotation                   ║
 * ║  - Multi-device session management via Session model         ║
 * ║  - Email verification (15-min, single-use)                   ║
 * ║  - Password reset flow (15-min, single-use)                  ║
 * ║  - Account lockout protection (5 attempts / 30 min)          ║
 * ║  - TOTP 2FA with backup codes                                ║
 * ║  - Refresh token reuse detection (revoke all on reuse)       ║
 * ║  - CSRF double-submit cookie pattern                         ║
 * ║  - Secure httpOnly cookie handling                            ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── Helpers ─────────────────────────────────────────

/**
 * Extract device info from request for session tracking.
 */
function getDeviceInfo(req) {
  const ua = req.headers['user-agent'] || 'Unknown';
  // Truncate to prevent DB bloat
  return ua.substring(0, 200);
}

/**
 * Extract client IP from request.
 */
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

/**
 * Create a new session with rotated refresh token.
 * Generates tokens, stores hashed refresh token in Session collection,
 * sets cookies, and returns access token.
 *
 * @param {Object} user - User document
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {number} statusCode - HTTP status code
 * @param {Object} options - { message, family }
 */
async function createSessionResponse(user, req, res, statusCode, options = {}) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const hashedToken = hashRefreshToken(refreshToken);

  // Generate a token family ID for reuse detection
  const family = options.family || crypto.randomBytes(16).toString('hex');

  const expiries = getTokenExpiries();

  // Create session document
  await Session.create({
    userId: user._id,
    hashedToken,
    family,
    deviceInfo: getDeviceInfo(req),
    ipAddress: getClientIP(req),
    expiresAt: new Date(Date.now() + expiries.refreshToken),
  });

  // Reset login attempts on successful auth
  if (user.loginAttempts > 0) {
    await user.resetLoginAttempts();
  }

  // Set refresh token as httpOnly cookie
  res.cookie('refreshToken', refreshToken, getRefreshTokenCookieOptions());

  // Set CSRF token (double-submit cookie pattern)
  const csrfToken = generateCsrfToken();
  setCsrfCookie(res, csrfToken);

  // Build response
  const responseData = {
    status: 'success',
    accessToken,
    csrfToken, // Also in response body so client can store in memory
    data: { user },
  };

  if (options.message) {
    responseData.message = options.message;
  }

  res.status(statusCode).json(responseData);
}

// ── Controllers ────────────────────────────────────

/**
 * POST /api/v1/auth/register
 * Register a new user with email verification.
 *
 * Performance optimizations:
 * - Single DB write (verification token generated before create)
 * - Email delivery is non-blocking (queued via BullMQ or fire-and-forget)
 * - No findOne pre-check; relies on MongoDB unique index + E11000 handling
 * - bcrypt runs in libuv thread pool (native binding, non-blocking)
 */
exports.register = catchAsync(async (req, res, next) => {
  const {
    name, email, password, role, phone, organizationName,
    location, address, city, state, country, citySlug, stateCode, regionCode,
  } = req.body;

  // Prevent self-registration as admin
  if (role === ROLE.ADMIN) {
    return next(new AppError(ERRORS.ADMIN_SELF_REGISTER, 403));
  }

  // Generate email verification token BEFORE create so we can include it
  // in a single DB write (eliminates the extra save() round-trip).
  const verificationToken = crypto.randomBytes(32).toString('hex');
  const hashedVerificationToken = crypto
    .createHash('sha256')
    .update(verificationToken)
    .digest('hex');

  // Single atomic DB write — relies on unique index on `email` for
  // duplicate detection (no TOCTOU race with findOne + create).
  let user;
  try {
    user = await User.create({
      name, email, password, role, phone, organizationName,
      location, address,
      city, state, country: country || 'India',
      citySlug, stateCode, regionCode,
      isVerified: role === ROLE.DONOR,
      isEmailVerified: false,
      emailVerificationToken: hashedVerificationToken,
      emailVerificationExpires: new Date(Date.now() + 15 * 60 * 1000),
    });
  } catch (err) {
    // Handle duplicate email (E11000)
    if (err.code === 11000) {
      // Case C: If existing user hasn't verified their email, allow re-registration
      // by updating their details and regenerating the verification token.
      // This handles the common scenario where a user registers, doesn't verify,
      // and tries to register again (or their verification token expired).
      const existingUser = await User.findOne({ email }).select(
        '+emailVerificationToken +emailVerificationExpires'
      );

      if (existingUser && !existingUser.isEmailVerified) {
        // Update the unverified user's details and regenerate token
        existingUser.name = name;
        existingUser.password = password; // pre-save hook will hash
        existingUser.role = role;
        existingUser.phone = phone;
        existingUser.organizationName = organizationName;
        existingUser.location = location;
        existingUser.address = address;
        existingUser.city = city;
        existingUser.state = state;
        existingUser.country = country || 'India';
        existingUser.citySlug = citySlug;
        existingUser.stateCode = stateCode;
        existingUser.regionCode = regionCode;
        existingUser.isVerified = role === ROLE.DONOR;
        existingUser.emailVerificationToken = hashedVerificationToken;
        existingUser.emailVerificationExpires = new Date(Date.now() + 15 * 60 * 1000);
        await existingUser.save();

        // Send new verification email (skip welcome — they may already have it)
        const reVerificationUrl = `${env.client.url.replace(/\/+$/, '')}/verify-email/${verificationToken}`;
        sendEmailVerification(existingUser, reVerificationUrl).catch((emailErr) =>
          logger.error(`Re-registration: verification email failed - ${emailErr.message}`)
        );

        return res.status(201).json({
          status: 'success',
          message: 'Registration successful. Please check your email to verify your account.',
          data: {
            user: {
              id: existingUser._id,
              name: existingUser.name,
              email: existingUser.email,
              role: existingUser.role,
            },
          },
        });
      }

      // Case B: Email exists and user is verified — return 409
      return next(new AppError(ERRORS.EMAIL_EXISTS, 409));
    }
    throw err; // Re-throw unexpected errors for the global handler
  }

  // Build verification URL
  const verificationUrl = `${env.client.url.replace(/\/+$/, '')}/verify-email/${verificationToken}`;

  // Non-blocking email delivery — do NOT await.
  // If Redis queue is available, emails go through BullMQ with retry.
  // If not, they fire-and-forget via direct SMTP.
  sendEmailVerification(user, verificationUrl).catch((err) =>
    logger.error(`Registration: verification email failed - ${err.message}`)
  );

  sendWelcomeEmail(user).catch((err) =>
    logger.error(`Registration: welcome email failed - ${err.message}`)
  );

  // Respond immediately — no waiting for email delivery
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
 * Login with email and password. If 2FA enabled, returns partial token.
 */
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  // Fetch user with security fields
  const user = await User.findOne({ email }).select(
    '+password +loginAttempts +lockUntil +twoFactorSecret +twoFactorEnabled'
  );

  // User not found — generic error
  if (!user) {
    return next(new AppError(ERRORS.INVALID_CREDENTIALS, 401));
  }

  // Verify password FIRST — prevents account state enumeration.
  // Lock/deactivated/unverified status only revealed after correct password,
  // so attackers can't distinguish locked accounts from non-existent ones.
  const isPasswordValid = await user.comparePassword(password);

  if (!isPasswordValid) {
    // Only increment attempts if account is not already locked
    if (!user.isLocked) {
      await user.incLoginAttempts();

      const newAttempts = (user.loginAttempts || 0) + 1;

      // Send lockout email if this attempt triggers the lock
      if (newAttempts >= User.MAX_LOGIN_ATTEMPTS) {
        sendAccountLockedEmail(user).catch((err) =>
          logger.error('Lockout email failed:', err.message)
        );
        return next(new AppError(ERRORS.ACCOUNT_LOCKED_ATTEMPTS, 423));
      }
    }

    // Generic error regardless of lock status — prevents enumeration
    return next(new AppError(ERRORS.INVALID_CREDENTIALS, 401));
  }

  // Password correct — safe to reveal account state to legitimate user

  // Account locked check
  if (user.isLocked) {
    return next(new AppError(ERRORS.ACCOUNT_LOCKED, 423));
  }

  // Account active check
  if (!user.isActive) {
    return next(new AppError(ERRORS.ACCOUNT_DEACTIVATED, 403));
  }

  // Email verification check — always enforced
  if (!user.isEmailVerified) {
    return next(new AppError(ERRORS.EMAIL_NOT_VERIFIED, 403));
  }

  // 2FA check — if enabled, return partial auth requiring TOTP
  if (user.twoFactorEnabled) {
    // Issue a short-lived "2FA pending" token (valid 5 min)
    const twoFactorToken = crypto.randomBytes(32).toString('hex');
    const hashedTwoFactorToken = crypto
      .createHash('sha256')
      .update(twoFactorToken)
      .digest('hex');

    // Store temporarily — reuse password reset fields with short expiry
    // Using a dedicated approach: store in a temp field or cache
    // For simplicity and security, we store as a session with a flag
    await Session.create({
      userId: user._id,
      hashedToken: hashedTwoFactorToken,
      family: `2fa-pending-${crypto.randomBytes(8).toString('hex')}`,
      deviceInfo: getDeviceInfo(req),
      ipAddress: getClientIP(req),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
      isRevoked: false,
    });

    // Reset login attempts since password was correct
    await user.resetLoginAttempts();

    return res.status(200).json({
      status: 'success',
      requiresTwoFactor: true,
      twoFactorToken,
      message: 'Please provide your 2FA code.',
    });
  }

  // No 2FA — issue tokens directly
  logger.info(`Login: ${user.email}`);
  await createSessionResponse(user, req, res, 200);
});

/**
 * POST /api/v1/auth/verify-2fa
 * Verify TOTP code after password authentication
 */
exports.verify2FA = catchAsync(async (req, res, next) => {
  const { twoFactorToken, totpCode, backupCode } = req.body;

  if (!twoFactorToken) {
    return next(new AppError('Two-factor token is required.', 400));
  }

  if (!totpCode && !backupCode) {
    return next(new AppError('Please provide a TOTP code or backup code.', 400));
  }

  // Find the pending 2FA session
  const hashedToken = crypto
    .createHash('sha256')
    .update(twoFactorToken)
    .digest('hex');

  // Atomically find and delete the pending 2FA session (prevents double-submit)
  const pendingSession = await Session.findOneAndDelete({
    hashedToken,
    isRevoked: false,
    family: { $regex: /^2fa-pending-/ },
    expiresAt: { $gt: new Date() },
  });

  if (!pendingSession) {
    return next(new AppError('Invalid or expired two-factor token. Please login again.', 401));
  }

  // Get user with 2FA fields
  const user = await User.findById(pendingSession.userId).select(
    '+twoFactorSecret +backupCodes +twoFactorEnabled'
  );

  if (!user || !user.twoFactorEnabled) {
    return next(new AppError('User not found or 2FA not enabled.', 401));
  }

  let isValid = false;

  if (totpCode) {
    // Verify TOTP code
    isValid = verifyTOTP(totpCode, user.twoFactorSecret);
  } else if (backupCode) {
    // Verify backup code
    const result = verifyBackupCode(backupCode, user.backupCodes);
    isValid = result.valid;

    if (isValid) {
      // Consume the backup code
      user.backupCodes = result.remainingCodes;
      await user.save({ validateBeforeSave: false });
    }
  }

  // Session already deleted atomically by findOneAndDelete above

  if (!isValid) {
    return next(new AppError('Invalid verification code.', 401));
  }

  // 2FA verified — issue full tokens
  logger.info(`Login (2FA): ${user.email}`);
  await createSessionResponse(user, req, res, 200);
});

/**
 * GET /api/v1/auth/verify-email/:token
 * Verify email address.
 * - Single-use: token cleared atomically via findOneAndUpdate
 * - Distinguishes expired (410) from invalid/used (400)
 * - Double-click safe: first wins, second gets 400
 */
exports.verifyEmail = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  // Atomic: find by token hash + not expired + not yet verified → set verified + clear token.
  // Prevents double-click race conditions (findOneAndUpdate is atomic in MongoDB).
  const user = await User.findOneAndUpdate(
    {
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: new Date() },
      isEmailVerified: false,
    },
    {
      $set: { isEmailVerified: true },
      $unset: { emailVerificationToken: 1, emailVerificationExpires: 1 },
    },
    { new: true }
  );

  if (user) {
    logger.info(`Email verified for ${user.email}`);
    return res.status(200).json({
      status: 'success',
      message: 'Email verified successfully. You can now log in.',
    });
  }

  // Token didn't match the atomic update — determine why:
  // Check if token exists at all (regardless of expiry/verified status)
  const tokenOwner = await User.findOne({ emailVerificationToken: hashedToken })
    .select('+emailVerificationExpires');

  if (tokenOwner) {
    // Token exists but atomic update failed — either expired or already verified
    if (tokenOwner.isEmailVerified) {
      // Already verified (second click after successful first click)
      return res.status(200).json({
        status: 'success',
        message: 'Email is already verified. You can log in.',
      });
    }
    // Token exists but expired
    return next(new AppError(ERRORS.EXPIRED_VERIFY_TOKEN, 410));
  }

  // Token not found at all — invalid or already consumed (single-use)
  return next(new AppError(ERRORS.INVALID_VERIFY_TOKEN, 400));
});

/**
 * POST /api/v1/auth/resend-verification
 * Resend email verification link
 */
exports.resendVerification = catchAsync(async (req, res, next) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  // Generic response to prevent email enumeration
  const successMsg = 'If an account exists, a verification email will be sent.';

  if (!user || user.isEmailVerified) {
    return res.status(200).json({ status: 'success', message: successMsg });
  }

  // Generate new verification token (invalidates the old one)
  const verificationToken = user.createEmailVerificationToken();
  await user.save({ validateBeforeSave: false });

  // Non-blocking email — fire-and-forget (consistent with registration)
  const verificationUrl = `${env.client.url.replace(/\/+$/, '')}/verify-email/${verificationToken}`;
  sendEmailVerification(user, verificationUrl).catch((err) => {
    logger.error(`Resend verification email failed: ${err.message}`);
    // Token stays in DB so user can retry via this endpoint again
  });

  res.status(200).json({ status: 'success', message: successMsg });
});

/**
 * POST /api/v1/auth/refresh-token
 * Rotate refresh token. Old token is invalidated immediately.
 * Detects token reuse and revokes entire family on violation.
 */
exports.refreshToken = catchAsync(async (req, res, next) => {
  const token = req.cookies?.refreshToken;

  if (!token) {
    return next(new AppError(ERRORS.NO_REFRESH_TOKEN, 401));
  }

  // Verify JWT signature
  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    return next(new AppError(ERRORS.INVALID_REFRESH_TOKEN, 401));
  }

  // Find user
  const user = await User.findById(decoded.id);
  if (!user) {
    return next(new AppError(ERRORS.USER_NOT_EXISTS, 401));
  }

  if (!user.isActive) {
    return next(new AppError(ERRORS.ACCOUNT_DEACTIVATED, 403));
  }

  // Check tokenVersion matches
  if ((decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
    return next(new AppError(ERRORS.RELOGIN_REQUIRED, 401));
  }

  // Atomically find and revoke the matching session (prevents TOCTOU race)
  const hashedIncoming = hashRefreshToken(token);
  const session = await Session.findOneAndUpdate(
    {
      userId: user._id,
      hashedToken: hashedIncoming,
      isRevoked: false,
      expiresAt: { $gt: new Date() },
    },
    { $set: { isRevoked: true } },
    { new: false } // return the document BEFORE update (so we can read family)
  );

  if (!session) {
    // Token not found in any active session — possible reuse attack.
    // Check if this token's family has any sessions (even revoked ones)
    // to determine if this was a previously valid token.
    const revokedSession = await Session.findOne({
      userId: user._id,
      hashedToken: hashedIncoming,
      isRevoked: true,
    });

    if (revokedSession) {
      // Confirmed reuse: old token was already rotated/revoked.
      // Revoke ALL sessions for this user as a security measure.
      await Session.revokeAllForUser(user._id);
      logger.warn(`SECURITY: Refresh token reuse detected for user ${user.email}. All sessions revoked.`);
    }

    return next(new AppError(ERRORS.TOKEN_REUSE, 401));
  }

  // Issue new token pair with the same family
  await createSessionResponse(user, req, res, 200, { family: session.family });
});

/**
 * POST /api/v1/auth/forgot-password
 * Request password reset email
 */
exports.forgotPassword = catchAsync(async (req, res, next) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  const successMsg = 'If an account exists with this email, a password reset link will be sent.';

  if (!user) {
    // Add small random delay to prevent timing-based email enumeration.
    // Without this, the immediate response for nonexistent emails is
    // distinguishable from the DB-write path for existing ones.
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    return res.status(200).json({ status: 'success', message: successMsg });
  }

  // Generate password reset token (15-min expiry, single-use)
  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  // Send password reset email — fire-and-forget to prevent timing leaks
  // that could reveal whether an account exists.
  const resetUrl = `${env.client.url.replace(/\/+$/, '')}/reset-password/${resetToken}`;
  sendPasswordResetEmail(user, resetUrl).catch(async (err) => {
    try {
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: false });
    } catch { /* ignore cleanup errors */ }
    logger.error(`Failed to send password reset email: ${err.message}`);
  });
  logger.info(`Password reset requested for ${email}`);

  res.status(200).json({ status: 'success', message: successMsg });
});

/**
 * POST /api/v1/auth/reset-password/:token
 * Reset password. Invalidates ALL sessions and clears token.
 * Distinguishes expired (410) from invalid/used (400) tokens.
 */
exports.resetPassword = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const { password } = req.body;

  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  // Find by token hash without expiry check — to distinguish expired vs invalid
  const user = await User.findOne({ passwordResetToken: hashedToken })
    .select('+passwordResetToken +passwordResetExpires +password');

  if (!user) {
    // Token not found at all — invalid or already consumed
    return next(new AppError(ERRORS.INVALID_RESET_TOKEN, 400));
  }

  // Check expiry
  if (!user.passwordResetExpires || user.passwordResetExpires < Date.now()) {
    return next(new AppError(ERRORS.EXPIRED_RESET_TOKEN, 410));
  }

  // Update password and clear token (triggers pre-save bcrypt hook)
  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;

  // Increment token version to invalidate all existing JWTs
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();

  // Revoke all sessions (force re-login on all devices)
  await Session.revokeAllForUser(user._id);

  // Send confirmation email
  sendPasswordChangedEmail(user).catch((err) =>
    logger.error('Password changed email failed:', err.message)
  );

  logger.info(`Password reset completed for ${user.email}`);

  res.status(200).json({
    status: 'success',
    message: 'Password reset successful. Please log in with your new password.',
  });
});

/**
 * POST /api/v1/auth/change-password
 * Change password (logged-in user). Invalidates all other sessions.
 */
exports.changePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id).select('+password');

  // Verify current password
  const isValid = await user.comparePassword(currentPassword);
  if (!isValid) {
    return next(new AppError(ERRORS.CURRENT_PASSWORD_WRONG, 401));
  }

  // Prevent reuse of same password
  const isSame = await user.comparePassword(newPassword);
  if (isSame) {
    return next(new AppError(ERRORS.SAME_PASSWORD, 400));
  }

  // Update password and bump token version
  user.password = newPassword;
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();

  // Revoke all existing sessions
  await Session.revokeAllForUser(user._id);

  // Issue new tokens for this device only
  await createSessionResponse(user, req, res, 200, {
    message: 'Password changed successfully. All other sessions have been logged out.',
  });

  // Notify user via email
  sendPasswordChangedEmail(user).catch((err) =>
    logger.error('Password changed email failed:', err.message)
  );
});

/**
 * POST /api/v1/auth/logout
 * Logout current device only.
 */
exports.logout = catchAsync(async (req, res) => {
  // Find and revoke the session matching the current refresh token
  const token = req.cookies?.refreshToken;
  if (token) {
    const hashedToken = hashRefreshToken(token);
    await Session.findOneAndUpdate(
      { userId: req.user._id, hashedToken, isRevoked: false },
      { isRevoked: true }
    );
  }

  // Clear cookies
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    path: '/api/v1/auth',
  });
  res.clearCookie('csrf-token', {
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    path: '/',
  });

  logger.info(`Logout: ${req.user.email}`);

  res.status(200).json({
    status: 'success',
    message: 'Logged out successfully.',
  });
});

/**
 * POST /api/v1/auth/logout-all
 * Logout from all devices. Bumps tokenVersion to invalidate all JWTs.
 */
exports.logoutAll = catchAsync(async (req, res) => {
  // Revoke all sessions
  await Session.revokeAllForUser(req.user._id);

  // Bump token version so all outstanding access tokens become invalid
  // (tokenVersion check in protect middleware rejects old tokens)
  await User.findByIdAndUpdate(req.user._id, {
    $inc: { tokenVersion: 1 },
  });

  // Clear cookies
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    path: '/api/v1/auth',
  });
  res.clearCookie('csrf-token', {
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    path: '/',
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
 * Update user profile (safe fields only)
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
    status: 'success',
    data: { user },
  });
});

/**
 * GET /api/v1/auth/sessions
 * Get all active sessions for the current user
 */
exports.getSessions = catchAsync(async (req, res) => {
  const sessions = await Session.getActiveSessions(req.user._id);

  res.status(200).json({
    status: 'success',
    data: {
      activeSessions: sessions.length,
      sessions,
    },
  });
});

/**
 * DELETE /api/v1/auth/sessions/:sessionId
 * Revoke a specific session (logout a specific device)
 */
exports.revokeSession = catchAsync(async (req, res, next) => {
  const { sessionId } = req.params;

  const session = await Session.findOne({
    _id: sessionId,
    userId: req.user._id,
    isRevoked: false,
  });

  if (!session) {
    return next(new AppError('Session not found.', 404));
  }

  session.isRevoked = true;
  await session.save();

  res.status(200).json({
    status: 'success',
    message: 'Session revoked successfully.',
  });
});

// ── 2FA Management ─────────────────────────────────

/**
 * POST /api/v1/auth/2fa/setup
 * Generate TOTP secret and return QR code URI.
 * Requires fresh authentication.
 */
exports.setup2FA = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user._id).select('+twoFactorEnabled');

  if (user.twoFactorEnabled) {
    return next(new AppError('Two-factor authentication is already enabled.', 400));
  }

  const { encryptedSecret, otpauthUrl, plainSecret } = generateTOTPSecret(user.email);

  // Store encrypted secret (not yet enabled — user must verify first)
  user.twoFactorSecret = encryptedSecret;
  await user.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    data: {
      otpauthUrl, // Client uses this to generate QR code
      secret: plainSecret, // Manual entry fallback
    },
  });
});

/**
 * POST /api/v1/auth/2fa/verify-setup
 * Verify TOTP code to confirm 2FA setup. Generates backup codes.
 */
exports.verifySetup2FA = catchAsync(async (req, res, next) => {
  const { totpCode } = req.body;

  if (!totpCode) {
    return next(new AppError('TOTP code is required.', 400));
  }

  const user = await User.findById(req.user._id).select(
    '+twoFactorSecret +twoFactorEnabled +backupCodes'
  );

  if (user.twoFactorEnabled) {
    return next(new AppError('Two-factor authentication is already enabled.', 400));
  }

  if (!user.twoFactorSecret) {
    return next(new AppError('Please run 2FA setup first.', 400));
  }

  // Verify the TOTP code
  const isValid = verifyTOTP(totpCode, user.twoFactorSecret);
  if (!isValid) {
    return next(new AppError('Invalid TOTP code. Please try again.', 400));
  }

  // Generate backup codes
  const { plainCodes, hashedCodes } = generateBackupCodes();

  // Enable 2FA
  user.twoFactorEnabled = true;
  user.backupCodes = hashedCodes;
  await user.save({ validateBeforeSave: false });

  logger.info(`2FA enabled for ${user.email}`);

  res.status(200).json({
    status: 'success',
    message: 'Two-factor authentication enabled successfully.',
    data: {
      backupCodes: plainCodes, // Show once, never again
    },
  });
});

/**
 * POST /api/v1/auth/2fa/disable
 * Disable 2FA. Requires current password for confirmation.
 */
exports.disable2FA = catchAsync(async (req, res, next) => {
  const { password } = req.body;

  if (!password) {
    return next(new AppError('Password is required to disable 2FA.', 400));
  }

  const user = await User.findById(req.user._id).select(
    '+password +twoFactorEnabled +twoFactorSecret +backupCodes'
  );

  if (!user.twoFactorEnabled) {
    return next(new AppError('Two-factor authentication is not enabled.', 400));
  }

  // Verify password
  const isValid = await user.comparePassword(password);
  if (!isValid) {
    return next(new AppError('Invalid password.', 401));
  }

  // Disable 2FA
  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  user.backupCodes = [];
  await user.save({ validateBeforeSave: false });

  logger.info(`2FA disabled for ${user.email}`);

  res.status(200).json({
    status: 'success',
    message: 'Two-factor authentication disabled.',
  });
});

/**
 * POST /api/v1/auth/2fa/regenerate-backup
 * Regenerate backup codes. Requires password confirmation.
 */
exports.regenerateBackupCodes = catchAsync(async (req, res, next) => {
  const { password } = req.body;

  if (!password) {
    return next(new AppError('Password is required.', 400));
  }

  const user = await User.findById(req.user._id).select(
    '+password +twoFactorEnabled +backupCodes'
  );

  if (!user.twoFactorEnabled) {
    return next(new AppError('Two-factor authentication is not enabled.', 400));
  }

  const isValid = await user.comparePassword(password);
  if (!isValid) {
    return next(new AppError('Invalid password.', 401));
  }

  const { plainCodes, hashedCodes } = generateBackupCodes();
  user.backupCodes = hashedCodes;
  await user.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    data: {
      backupCodes: plainCodes,
    },
  });
});
