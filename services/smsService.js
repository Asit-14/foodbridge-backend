const logger = require('../utils/logger');
const env = require('../config/env');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                  SMS NOTIFICATION SERVICE                     ║
 * ║                                                              ║
 * ║  Sends transactional SMS for critical events:                ║
 * ║    - OTP for pickup verification                             ║
 * ║    - Donation status alerts                                  ║
 * ║                                                              ║
 * ║  Supported providers:                                        ║
 * ║    - Twilio (international)                                  ║
 * ║    - Fast2SMS (India)                                        ║
 * ║                                                              ║
 * ║  Falls back silently if SMS is not configured.               ║
 * ║  Always falls back to email when SMS fails.                  ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

let smsClient = null;
let smsProvider = null;

/**
 * Initialize SMS client based on configured provider.
 * Call once at startup. Safe to call if no SMS env vars are set.
 */
function initSMS() {
  const provider = env.sms?.provider;

  if (!provider) {
    logger.warn('SMS not configured — SMS notifications disabled. Set SMS_PROVIDER to enable.');
    return;
  }

  try {
    if (provider === 'twilio') {
      if (!env.sms.accountSid || !env.sms.authToken || !env.sms.fromNumber) {
        logger.error('SMS (Twilio): Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER');
        return;
      }

      // Lazy-require twilio — only load if configured
      const twilio = require('twilio');
      smsClient = twilio(env.sms.accountSid, env.sms.authToken);
      smsProvider = 'twilio';
      logger.info('SMS (Twilio) initialized');

    } else if (provider === 'fast2sms') {
      if (!env.sms.apiKey) {
        logger.error('SMS (Fast2SMS): Missing FAST2SMS_API_KEY');
        return;
      }

      // Fast2SMS uses HTTP API — no SDK needed, we use fetch/axios
      smsClient = { apiKey: env.sms.apiKey };
      smsProvider = 'fast2sms';
      logger.info('SMS (Fast2SMS) initialized');

    } else {
      logger.error(`SMS: Unknown provider "${provider}". Supported: twilio, fast2sms`);
    }
  } catch (err) {
    logger.error(`SMS initialization failed: ${err.message}`);
  }
}

/**
 * Send an SMS message.
 * @param {string} to - Phone number (E.164 format for Twilio, 10-digit for Fast2SMS)
 * @param {string} message - Text message body
 * @returns {Promise<boolean>} Whether the SMS was sent successfully
 */
async function sendSMS(to, message) {
  if (!smsClient || !smsProvider) {
    logger.debug(`[DEBUG] SMS SKIPPED (not configured): "${message.substring(0, 50)}..." → ${to}`);
    return false;
  }

  // Sanitize phone number
  const phone = to.replace(/[\s\-()]/g, '');

  try {
    logger.debug(`[DEBUG] Sending SMS via ${smsProvider}: → ${phone}`);

    if (smsProvider === 'twilio') {
      await smsClient.messages.create({
        body: message,
        from: env.sms.fromNumber,
        to: phone,
      });

    } else if (smsProvider === 'fast2sms') {
      // Fast2SMS DLT route (India)
      const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
          authorization: smsClient.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          route: 'otp',
          variables_values: message,
          numbers: phone.replace(/^\+91/, ''), // Strip country code for Fast2SMS
        }),
      });

      const result = await response.json();
      if (!result.return) {
        throw new Error(result.message || 'Fast2SMS API returned failure');
      }
    }

    logger.info(`SMS sent via ${smsProvider}: → ${phone}`);
    return true;

  } catch (err) {
    logger.error(`SMS FAILED via ${smsProvider}: → ${phone} — ${err.message}`, { stack: err.stack });
    return false;
  }
}

/**
 * Send OTP via SMS.
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} otp - The OTP code
 * @returns {Promise<boolean>}
 */
async function sendOTPviaSMS(phoneNumber, otp) {
  if (!phoneNumber) {
    logger.debug('[DEBUG] SMS OTP skipped — no phone number provided');
    return false;
  }

  const message = `Your FoodBridge pickup verification code is: ${otp}. Do not share this with anyone.`;
  return sendSMS(phoneNumber, message);
}

// Initialize on module load
initSMS();

module.exports = {
  sendSMS,
  sendOTPviaSMS,
  initSMS,
};
