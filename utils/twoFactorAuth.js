const {
  generateSecret,
  generateURI,
  verifySync,
} = require('otplib');
const crypto = require('crypto');
const { encrypt, decrypt } = require('./cryptoUtils');
const env = require('../config/env');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              TWO-FACTOR AUTHENTICATION (TOTP)                ║
 * ║                                                              ║
 * ║  Time-based One-Time Password using authenticator apps.      ║
 * ║  - Secret generation and encryption at rest                  ║
 * ║  - QR code URI for Google Authenticator / Authy              ║
 * ║  - TOTP verification with clock drift tolerance              ║
 * ║  - Backup codes (10 single-use, hashed in DB)                ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

/**
 * Get the encryption key for 2FA secrets.
 * Derives a 32-byte key from JWT_SECRET using SHA-256.
 */
function getEncryptionKey() {
  return crypto
    .createHash('sha256')
    .update(env.jwt.secret)
    .digest('hex');
}

/**
 * Generate a new TOTP secret and encrypt it for storage.
 * @param {string} userEmail - User's email for the QR URI label
 * @returns {{ encryptedSecret: string, otpauthUrl: string, plainSecret: string }}
 */
function generateTOTPSecret(userEmail) {
  const secret = generateSecret();
  const encryptionKey = getEncryptionKey();
  const encryptedSecret = encrypt(secret, encryptionKey);

  const otpauthUrl = generateURI({
    issuer: 'FoodBridge',
    label: userEmail,
    secret,
    type: 'totp',
  });

  return { encryptedSecret, otpauthUrl, plainSecret: secret };
}

/**
 * Decrypt a stored TOTP secret.
 * @param {string} encryptedSecret - Encrypted secret from DB
 * @returns {string|null} Decrypted secret or null if failed
 */
function decryptTOTPSecret(encryptedSecret) {
  const encryptionKey = getEncryptionKey();
  return decrypt(encryptedSecret, encryptionKey);
}

/**
 * Verify a TOTP code against the stored secret.
 * Allows 1-step window for clock drift (±30 seconds).
 * @param {string} token - 6-digit TOTP code from user
 * @param {string} encryptedSecret - Encrypted secret from DB
 * @returns {boolean} Whether the code is valid
 */
function verifyTOTP(token, encryptedSecret) {
  const secret = decryptTOTPSecret(encryptedSecret);
  if (!secret) return false;

  const result = verifySync({ token, secret, window: 1 });
  return result?.valid === true;
}

/**
 * Generate backup codes (10 codes, 8 chars each).
 * Returns both plain codes (to show user once) and hashed codes (to store).
 * @returns {{ plainCodes: string[], hashedCodes: string[] }}
 */
function generateBackupCodes() {
  const codes = [];
  const hashedCodes = [];

  for (let i = 0; i < 10; i++) {
    // 8 random bytes = 16 hex chars = 2^64 entropy (infeasible to rainbow-table)
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    codes.push(code);
    hashedCodes.push(hashBackupCode(code));
  }

  return { plainCodes: codes, hashedCodes };
}

/**
 * Hash a backup code for storage.
 * @param {string} code - Plain backup code
 * @returns {string} SHA-256 hash
 */
function hashBackupCode(code) {
  return crypto
    .createHash('sha256')
    .update(code.toUpperCase().replace(/\s/g, ''))
    .digest('hex');
}

/**
 * Verify and consume a backup code.
 * @param {string} code - Plain backup code from user
 * @param {string[]} hashedCodes - Array of hashed codes from DB
 * @returns {{ valid: boolean, remainingCodes: string[] }}
 */
function verifyBackupCode(code, hashedCodes) {
  const hashed = hashBackupCode(code);
  const index = hashedCodes.indexOf(hashed);

  if (index === -1) {
    return { valid: false, remainingCodes: hashedCodes };
  }

  const remainingCodes = [...hashedCodes];
  remainingCodes.splice(index, 1);

  return { valid: true, remainingCodes };
}

module.exports = {
  generateTOTPSecret,
  decryptTOTPSecret,
  verifyTOTP,
  generateBackupCodes,
  hashBackupCode,
  verifyBackupCode,
};
