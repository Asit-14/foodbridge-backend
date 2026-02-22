const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const env = require('../config/env');
const { enqueueEmail, isQueueAvailable } = require('../queues/emailQueue');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           EMAIL NOTIFICATION SERVICE (SMTP)                  ║
 * ║                                                              ║
 * ║  High-performance email delivery with:                       ║
 * ║  - SMTP connection pooling (pool: true, maxConnections: 5)   ║
 * ║  - BullMQ queue integration for async delivery               ║
 * ║  - Automatic fallback to direct SMTP when Redis unavailable  ║
 * ║  - Singleton transporter (reused across all requests)        ║
 * ║                                                              ║
 * ║  Priority: Queue (async) → Direct SMTP (sync fallback)       ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

let transporter = null;
let smtpReady = false;

function initTransporter() {
  if (!env.smtp || !env.smtp.host) {
    logger.warn('SMTP not configured — email notifications disabled');
    return;
  }

  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: {
      user: env.smtp.user,
      pass: env.smtp.pass,
    },
    // Connection pooling — reuses TCP connections across sendMail calls
    pool: true,
    maxConnections: 5,
    maxMessages: 100,    // Send up to 100 emails per connection before reconnecting
    // Force IPv4 — Render has no IPv6 outbound, Gmail resolves to IPv6 first
    family: 4,
    // Timeouts to prevent hanging connections
    connectionTimeout: 10000,  // 10s to establish connection
    greetingTimeout: 10000,    // 10s for SMTP greeting
    socketTimeout: 30000,      // 30s for socket inactivity
  });

  transporter.verify()
    .then(() => {
      smtpReady = true;
      logger.info('SMTP transporter verified and ready (pooled, maxConn=5)');
    })
    .catch((err) => {
      smtpReady = false;
      logger.error(`SMTP verification failed: ${err.message}`);
    });
}

// Initialize on module load
initTransporter();

/**
 * Get SMTP health status for the health check endpoint.
 */
function getSmtpStatus() {
  if (!transporter) return 'not_configured';
  return smtpReady ? 'ready' : 'failed';
}

// ── Email templates ──────────────────────────────────

function baseTemplate(title, body) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f3f4f6; }
    .container { max-width: 560px; margin: 20px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    .header { background: linear-gradient(135deg, #059669, #10b981); padding: 24px 32px; text-align: center; }
    .header h1 { color: #fff; margin: 0; font-size: 20px; }
    .header .emoji { font-size: 28px; display: block; margin-bottom: 8px; }
    .body { padding: 32px; color: #374151; line-height: 1.6; }
    .body h2 { margin-top: 0; color: #111827; font-size: 18px; }
    .highlight { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 16px; margin: 16px 0; }
    .otp-box { text-align: center; padding: 20px; }
    .otp-code { font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #059669; background: #f0fdf4; border: 2px dashed #10b981; border-radius: 12px; padding: 16px 24px; display: inline-block; }
    .btn { display: inline-block; background: #059669; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-weight: 600; font-size: 14px; }
    .footer { padding: 20px 32px; text-align: center; color: #9ca3af; font-size: 12px; border-top: 1px solid #f3f4f6; }
    .meta { font-size: 13px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="emoji">🍃</span>
      <h1>FoodBridge</h1>
    </div>
    <div class="body">
      <h2>${title}</h2>
      ${body}
    </div>
    <div class="footer">
      FoodBridge — Smart Food Waste Reduction Platform<br/>
      Reducing waste, feeding communities.
    </div>
  </div>
</body>
</html>`;
}

// ── Core send function (direct SMTP) ──────────────────

async function sendEmail({ to, subject, title, body }) {
  if (!transporter) {
    logger.warn(`Email SKIPPED (no SMTP transporter): "${subject}" → ${to}. Check SMTP_HOST, SMTP_USER, SMTP_PASS env vars.`);
    return false;
  }

  try {
    const html = baseTemplate(title || subject, body);
    const start = Date.now();
    await transporter.sendMail({
      from: `"FoodBridge" <${env.smtp.from || env.smtp.user}>`,
      to,
      subject,
      html,
    });
    const elapsed = Date.now() - start;
    logger.info(`Email sent: ${subject} → ${to} (${elapsed}ms)`);
    return true;
  } catch (err) {
    logger.error(`Email FAILED: "${subject}" → ${to} — ${err.message}`, { stack: err.stack });
    return false;
  }
}

// ── Queue-aware email functions ────────────────────────
// Each function tries the queue first, falls back to direct SMTP.

async function sendWelcomeEmail(user) {
  const queued = await enqueueEmail('welcome', {
    to: user.email,
    name: user.name,
    role: user.role,
  });
  if (queued) return true;

  // Direct SMTP fallback
  return sendEmail({
    to: user.email,
    subject: 'Welcome to FoodBridge!',
    title: `Welcome, ${user.name}!`,
    body: `
      <p>Thank you for joining FoodBridge — the smart food waste reduction platform.</p>
      <div class="highlight">
        <p><strong>Your role:</strong> ${user.role === 'donor' ? 'Food Donor' : 'NGO Partner'}</p>
        ${user.role === 'ngo' ? '<p>Your account will be verified by our admin team shortly. You\'ll receive a notification once approved.</p>' : '<p>You can start creating donations right away!</p>'}
      </div>
      <p>Together, we can reduce food waste and feed more people.</p>
    `,
  });
}

async function sendDonationAcceptedEmail(donor, ngo, donation) {
  return sendEmail({
    to: donor.email,
    subject: `Donation Accepted: ${donation.foodType}`,
    title: 'Your Donation Has Been Accepted!',
    body: `
      <p>Great news! An NGO has accepted your food donation.</p>
      <div class="highlight">
        <p><strong>Food:</strong> ${donation.foodType} (${donation.quantity} ${donation.unit || 'servings'})</p>
        <p><strong>Accepted by:</strong> ${ngo.organizationName || ngo.name}</p>
        <p><strong>Pickup Address:</strong> ${donation.pickupAddress}</p>
      </div>
      <p>The NGO is on their way. Please keep the food ready for pickup.</p>
    `,
  });
}

async function sendOTPEmail(donor, donation, otp) {
  return sendEmail({
    to: donor.email,
    subject: `Pickup OTP: ${donation.foodType}`,
    title: 'Your Pickup Verification Code',
    body: `
      <p>Share this OTP with the NGO representative when they arrive for pickup:</p>
      <div class="otp-box">
        <span class="otp-code">${otp}</span>
      </div>
      <p class="meta"><strong>Donation:</strong> ${donation.foodType} (${donation.quantity} ${donation.unit || 'servings'})</p>
      <p class="meta">This OTP ensures secure handover of your food donation.</p>
    `,
  });
}

async function sendDeliveryConfirmationEmail(donor, donation, beneficiaryCount) {
  return sendEmail({
    to: donor.email,
    subject: `Delivery Confirmed: ${donation.foodType}`,
    title: 'Donation Successfully Delivered!',
    body: `
      <p>Your food donation has been successfully delivered to those in need.</p>
      <div class="highlight">
        <p><strong>Food:</strong> ${donation.foodType}</p>
        <p><strong>Quantity:</strong> ${donation.quantity} ${donation.unit || 'servings'}</p>
        <p><strong>People fed:</strong> ${beneficiaryCount || 'Multiple beneficiaries'}</p>
      </div>
      <p>Thank you for making a difference! Every meal counts.</p>
    `,
  });
}

async function sendExpiryWarningEmail(donor, donation) {
  return sendEmail({
    to: donor.email,
    subject: `Expiry Warning: ${donation.foodType}`,
    title: 'Your Donation is About to Expire',
    body: `
      <p>Your donation is approaching its expiry time and hasn't been picked up yet.</p>
      <div class="highlight" style="background:#fef2f2; border-color:#fecaca;">
        <p><strong>Food:</strong> ${donation.foodType}</p>
        <p><strong>Expires:</strong> ${new Date(donation.expiryTime).toLocaleString()}</p>
      </div>
      <p>We're actively looking for an NGO to pick it up. You may also consider extending the pickup window if possible.</p>
    `,
  });
}

async function sendReassignmentEmail(donor, donation, attemptNumber) {
  return sendEmail({
    to: donor.email,
    subject: `Donation Reassigned: ${donation.foodType}`,
    title: 'Finding a New NGO',
    body: `
      <p>The previously assigned NGO didn't complete the pickup. We're reassigning your donation.</p>
      <div class="highlight">
        <p><strong>Food:</strong> ${donation.foodType}</p>
        <p><strong>Reassignment attempt:</strong> ${attemptNumber} of 3</p>
      </div>
      <p>Our matching engine is finding the next best NGO for your donation.</p>
    `,
  });
}

async function sendNGOVerifiedEmail(ngo) {
  return sendEmail({
    to: ngo.email,
    subject: 'Account Verified — Welcome to FoodBridge!',
    title: 'Your NGO Account is Verified!',
    body: `
      <p>Congratulations! Your NGO account has been verified by our admin team.</p>
      <div class="highlight">
        <p><strong>Organization:</strong> ${ngo.organizationName || ngo.name}</p>
      </div>
      <p>You can now accept food donations in your area. Log in to see available donations nearby.</p>
    `,
  });
}

async function sendEmailVerification(user, verificationUrl) {
  const queued = await enqueueEmail('verification', {
    to: user.email,
    name: user.name,
    verificationUrl,
  });
  if (queued) return true;

  // Direct SMTP fallback
  return sendEmail({
    to: user.email,
    subject: 'Verify Your Email — FoodBridge',
    title: 'Verify Your Email Address',
    body: `
      <p>Hi ${user.name},</p>
      <p>Thank you for registering with FoodBridge! Please verify your email address to activate your account.</p>
      <div class="otp-box">
        <a href="${verificationUrl}" class="btn" style="color: #fff !important; text-decoration: none;">Verify Email Address</a>
      </div>
      <p class="meta">Or copy and paste this link into your browser:</p>
      <p class="meta" style="word-break: break-all;">${verificationUrl}</p>
      <div class="highlight" style="background:#fef3c7; border-color:#fcd34d;">
        <p><strong>⏰ This link expires in 15 minutes.</strong></p>
        <p>If you didn't create an account, you can safely ignore this email.</p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(user, resetUrl) {
  const queued = await enqueueEmail('passwordReset', {
    to: user.email,
    name: user.name,
    resetUrl,
  });
  if (queued) return true;

  // Direct SMTP fallback
  return sendEmail({
    to: user.email,
    subject: 'Reset Your Password — FoodBridge',
    title: 'Password Reset Request',
    body: `
      <p>Hi ${user.name},</p>
      <p>We received a request to reset your password. Click the button below to create a new password:</p>
      <div class="otp-box">
        <a href="${resetUrl}" class="btn" style="color: #fff !important; text-decoration: none;">Reset Password</a>
      </div>
      <p class="meta">Or copy and paste this link into your browser:</p>
      <p class="meta" style="word-break: break-all;">${resetUrl}</p>
      <div class="highlight" style="background:#fef2f2; border-color:#fecaca;">
        <p><strong>⏰ This link expires in 15 minutes.</strong></p>
        <p>If you didn't request a password reset, please ignore this email or contact support if you have concerns.</p>
      </div>
    `,
  });
}

async function sendPasswordChangedEmail(user) {
  const queued = await enqueueEmail('passwordChanged', {
    to: user.email,
    name: user.name,
  });
  if (queued) return true;

  // Direct SMTP fallback
  return sendEmail({
    to: user.email,
    subject: 'Password Changed — FoodBridge',
    title: 'Your Password Has Been Changed',
    body: `
      <p>Hi ${user.name},</p>
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
}

async function sendAccountLockedEmail(user) {
  const queued = await enqueueEmail('accountLocked', {
    to: user.email,
    name: user.name,
  });
  if (queued) return true;

  // Direct SMTP fallback
  return sendEmail({
    to: user.email,
    subject: 'Account Security Alert — FoodBridge',
    title: 'Your Account Has Been Temporarily Locked',
    body: `
      <p>Hi ${user.name},</p>
      <p>We detected multiple failed login attempts on your account. For your security, we've temporarily locked your account.</p>
      <div class="highlight" style="background:#fef2f2; border-color:#fecaca;">
        <p><strong>Your account will be automatically unlocked in 30 minutes.</strong></p>
      </div>
      <p>If this was you, please wait and try again later. If you've forgotten your password, you can reset it.</p>
      <p>If you didn't attempt to log in, someone else may be trying to access your account. We recommend resetting your password.</p>
    `,
  });
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendDonationAcceptedEmail,
  sendOTPEmail,
  sendDeliveryConfirmationEmail,
  sendExpiryWarningEmail,
  sendReassignmentEmail,
  sendNGOVerifiedEmail,
  sendEmailVerification,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountLockedEmail,
  getSmtpStatus,
};
