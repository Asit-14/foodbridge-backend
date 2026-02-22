module.exports = Object.freeze({
  // ── Auth ──
  INVALID_CREDENTIALS: 'Invalid email or password.',
  ACCOUNT_LOCKED: 'Account is temporarily locked. Try again later.',
  ACCOUNT_LOCKED_ATTEMPTS: 'Account locked due to too many failed attempts. Try again later.',
  ACCOUNT_DEACTIVATED: 'Account has been deactivated. Contact support.',
  EMAIL_NOT_VERIFIED: 'Please verify your email address before logging in.',
  ADMIN_SELF_REGISTER: 'Admin accounts cannot be self-registered.',
  EMAIL_EXISTS: 'An account with this email already exists.',
  INVALID_RESET_TOKEN: 'Invalid or already used password reset token.',
  EXPIRED_RESET_TOKEN: 'Password reset link has expired. Please request a new one.',
  INVALID_VERIFY_TOKEN: 'Invalid or already used verification token.',
  EXPIRED_VERIFY_TOKEN: 'Verification link has expired. Please request a new one.',
  NO_REFRESH_TOKEN: 'No refresh token provided.',
  INVALID_REFRESH_TOKEN: 'Invalid or expired refresh token.',
  RELOGIN_REQUIRED: 'Please log in again.',
  USER_NOT_EXISTS: 'User no longer exists.',
  CURRENT_PASSWORD_WRONG: 'Current password is incorrect.',
  SAME_PASSWORD: 'New password must be different from current password.',
  TOKEN_REUSE: 'Invalid refresh token. Please log in again.',
  CSRF_MISSING: 'CSRF token missing. Please refresh and try again.',
  CSRF_INVALID: 'Invalid CSRF token.',

  // ── Donations ──
  DONATION_NOT_FOUND: 'Donation not found.',
  INVALID_STATUS_TRANSITION: (status) => `Cannot perform this action on a donation with status "${status}".`,
  TOO_CLOSE_TO_EXPIRY: 'Donation is too close to expiry to accept safely.',
  ONLY_ACCEPTING_NGO: 'Only the accepting NGO can perform this action.',
  ONLY_DONOR_CAN_EDIT: 'Only the donor can edit their donation.',
  ONLY_DONOR_CAN_CANCEL: 'Only the donor can cancel their donation.',
  EDIT_ONLY_AVAILABLE: 'Can only edit donations with status "Available".',
  CANCEL_ONLY_AVAILABLE: (status) => `Cannot cancel a donation with status "${status}". Only Available donations can be cancelled.`,
  PICKUP_LOG_NOT_FOUND: 'Pickup log not found.',
  INVALID_OTP: 'Invalid OTP. Please check with the donor.',
  MISSING_COORDINATES: 'Please provide lat and lng query parameters.',

  // ── Users ──
  USER_NOT_FOUND: 'User not found.',

  // ── Email ──
  EMAIL_SEND_FAILED: 'Failed to send email. Try again later.',
  VERIFY_EMAIL_FAILED: 'Failed to send verification email. Try again later.',
});
