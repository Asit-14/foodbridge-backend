const crypto = require('crypto');

/**
 * Generate a numeric OTP.
 * @param {number} length - OTP length (default: 6)
 * @returns {string} Numeric OTP
 */
function generateOTP(length = 6) {
  const digits = '0123456789';
  let otp = '';

  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    otp += digits[randomBytes[i] % 10];
  }

  return otp;
}

module.exports = { generateOTP };
