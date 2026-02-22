module.exports = Object.freeze({
  // ── Auth ──
  ADMIN_SELF_REGISTER: 'Admin accounts cannot be self-registered.',
  EMAIL_EXISTS: 'An account with this email already exists.',

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
});
