const crypto = require('crypto');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                  CRYPTO UTILITY MODULE                       ║
 * ║                                                              ║
 * ║  Secure cryptographic operations for:                        ║
 * ║  - Token generation and hashing                              ║
 * ║  - OTP generation                                            ║
 * ║  - Secure string comparison                                  ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

/**
 * Generate a cryptographically secure random token
 * @param {number} bytes - Number of bytes (default: 32)
 * @returns {string} Hex-encoded random token
 */
function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate a URL-safe random token
 * @param {number} bytes - Number of bytes (default: 32)
 * @returns {string} URL-safe base64-encoded token
 */
function generateUrlSafeToken(bytes = 32) {
  return crypto.randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Hash a token using SHA-256
 * @param {string} token - Plain token to hash
 * @returns {string} Hex-encoded hash
 */
function hashToken(token) {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
}

/**
 * Generate a numeric OTP
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

/**
 * Timing-safe string comparison
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} Whether strings are equal
 */
function secureCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  
  if (bufA.length !== bufB.length) {
    // Still perform comparison to prevent timing attacks
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Encrypt data using AES-256-GCM
 * @param {string} plaintext - Data to encrypt
 * @param {string} key - Encryption key (32 bytes hex)
 * @returns {string} Encrypted data with IV and auth tag
 */
function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt data using AES-256-GCM
 * @param {string} ciphertext - Encrypted data
 * @param {string} key - Encryption key (32 bytes hex)
 * @returns {string|null} Decrypted data or null if failed
 */
function decrypt(ciphertext, key) {
  try {
    const [ivHex, authTagHex, encrypted] = ciphertext.split(':');
    
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch {
    return null;
  }
}

/**
 * Generate a secure verification code for email
 * Shorter format that's easy to type
 * @returns {string} 8-character alphanumeric code
 */
function generateVerificationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed ambiguous chars
  let code = '';
  
  const randomBytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += chars[randomBytes[i] % chars.length];
  }
  
  return code;
}

module.exports = {
  generateSecureToken,
  generateUrlSafeToken,
  hashToken,
  generateOTP,
  secureCompare,
  encrypt,
  decrypt,
  generateVerificationCode,
};
