const { Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const logger = require('../utils/logger');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                 EMAIL WORKER (CONSUMER)                      ║
 * ║                                                              ║
 * ║  Processes email jobs from the BullMQ queue using the        ║
 * ║  pooled SMTP transporter.                                    ║
 * ║                                                              ║
 * ║  Concurrency: 5 (processes 5 emails simultaneously)          ║
 * ║  Limiter: max 20 emails per 10 seconds (SMTP rate limit)     ║
 * ║                                                              ║
 * ║  Each job type maps to a handler that calls the email        ║
 * ║  service's sendEmail function with the appropriate template. ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const QUEUE_NAME = 'email';

let emailWorker = null;

/**
 * Email job handlers — one per email type.
 * Each handler receives the job data and calls the email service directly.
 */
const handlers = {
  verification: async (data, sendEmail) => {
    return sendEmail({
      to: data.to,
      subject: 'Verify Your Email — FoodBridge',
      title: 'Verify Your Email Address',
      body: `
        <p>Hi ${data.name},</p>
        <p>Thank you for registering with FoodBridge! Please verify your email address to activate your account.</p>
        <div class="otp-box">
          <a href="${data.verificationUrl}" class="btn" style="color: #fff !important; text-decoration: none;">Verify Email Address</a>
        </div>
        <p class="meta">Or copy and paste this link into your browser:</p>
        <p class="meta" style="word-break: break-all;">${data.verificationUrl}</p>
        <div class="highlight" style="background:#fef3c7; border-color:#fcd34d;">
          <p><strong>⏰ This link expires in 15 minutes.</strong></p>
          <p>If you didn't create an account, you can safely ignore this email.</p>
        </div>
      `,
    });
  },

  welcome: async (data, sendEmail) => {
    const roleText = data.role === 'donor' ? 'Food Donor' : 'NGO Partner';
    const roleMsg = data.role === 'ngo'
      ? '<p>Your account will be verified by our admin team shortly. You\'ll receive a notification once approved.</p>'
      : '<p>You can start creating donations right away!</p>';

    return sendEmail({
      to: data.to,
      subject: 'Welcome to FoodBridge!',
      title: `Welcome, ${data.name}!`,
      body: `
        <p>Thank you for joining FoodBridge — the smart food waste reduction platform.</p>
        <div class="highlight">
          <p><strong>Your role:</strong> ${roleText}</p>
          ${roleMsg}
        </div>
        <p>Together, we can reduce food waste and feed more people.</p>
      `,
    });
  },

  passwordReset: async (data, sendEmail) => {
    return sendEmail({
      to: data.to,
      subject: 'Reset Your Password — FoodBridge',
      title: 'Password Reset Request',
      body: `
        <p>Hi ${data.name},</p>
        <p>We received a request to reset your password. Click the button below to create a new password:</p>
        <div class="otp-box">
          <a href="${data.resetUrl}" class="btn" style="color: #fff !important; text-decoration: none;">Reset Password</a>
        </div>
        <p class="meta">Or copy and paste this link into your browser:</p>
        <p class="meta" style="word-break: break-all;">${data.resetUrl}</p>
        <div class="highlight" style="background:#fef2f2; border-color:#fecaca;">
          <p><strong>⏰ This link expires in 15 minutes.</strong></p>
          <p>If you didn't request a password reset, please ignore this email or contact support if you have concerns.</p>
        </div>
      `,
    });
  },

  passwordChanged: async (data, sendEmail) => {
    return sendEmail({
      to: data.to,
      subject: 'Password Changed — FoodBridge',
      title: 'Your Password Has Been Changed',
      body: `
        <p>Hi ${data.name},</p>
        <p>This is a confirmation that your password was recently changed.</p>
        <div class="highlight">
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
        </div>
        <div class="highlight" style="background:#fef2f2; border-color:#fecaca;">
          <p><strong>⚠️ Didn't make this change?</strong></p>
          <p>If you didn't change your password, please contact our support team immediately and reset your password.</p>
        </div>
      `,
    });
  },

  accountLocked: async (data, sendEmail) => {
    return sendEmail({
      to: data.to,
      subject: 'Account Security Alert — FoodBridge',
      title: 'Your Account Has Been Temporarily Locked',
      body: `
        <p>Hi ${data.name},</p>
        <p>We detected multiple failed login attempts on your account. For your security, we've temporarily locked your account.</p>
        <div class="highlight" style="background:#fef2f2; border-color:#fecaca;">
          <p><strong>Your account will be automatically unlocked in 30 minutes.</strong></p>
        </div>
        <p>If this was you, please wait and try again later. If you've forgotten your password, you can reset it.</p>
        <p>If you didn't attempt to log in, someone else may be trying to access your account. We recommend resetting your password.</p>
      `,
    });
  },
};

/**
 * Start the email worker.
 * Must be called after Redis is confirmed available.
 *
 * @param {Function} sendEmailFn - The sendEmail function from emailService
 */
function startEmailWorker(sendEmailFn) {
  if (emailWorker) {
    logger.warn('Email worker already running');
    return emailWorker;
  }

  emailWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { type, ...data } = job.data;
      const handler = handlers[type];

      if (!handler) {
        throw new Error(`Unknown email type: ${type}`);
      }

      const start = Date.now();
      const result = await handler(data, sendEmailFn);
      const elapsed = Date.now() - start;

      if (!result) {
        throw new Error(`Email send returned false for ${type} → ${data.to}`);
      }

      logger.info(`Email delivered: ${type} → ${data.to} (${elapsed}ms)`);
      return { delivered: true, elapsed };
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
      limiter: {
        max: 20,
        duration: 10000, // 20 emails per 10 seconds
      },
    }
  );

  emailWorker.on('completed', (job) => {
    logger.debug(`Email job ${job.id} completed`);
  });

  emailWorker.on('failed', (job, err) => {
    logger.error(`Email job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}`);
  });

  emailWorker.on('error', (err) => {
    logger.error(`Email worker error: ${err.message}`);
  });

  logger.info('Email worker started (concurrency=5, rate=20/10s)');
  return emailWorker;
}

/**
 * Graceful shutdown — close the worker.
 */
async function stopEmailWorker() {
  if (emailWorker) {
    await emailWorker.close();
    emailWorker = null;
    logger.info('Email worker stopped');
  }
}

module.exports = { startEmailWorker, stopEmailWorker };
