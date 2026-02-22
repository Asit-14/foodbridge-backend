const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const env = require('../config/env');

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
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    family: 4,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
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

initTransporter();

function getSmtpStatus() {
  if (!transporter) return 'not_configured';
  return smtpReady ? 'ready' : 'failed';
}

// ── Email template ──────────────────────────────────

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

// ── Core send function ──────────────────────────────

async function sendEmail({ to, subject, title, body }) {
  if (!transporter) {
    logger.warn(`Email SKIPPED (no SMTP transporter): "${subject}" → ${to}.`);
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

// ── Domain-specific email functions ─────────────────

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

module.exports = {
  sendEmail,
  sendDonationAcceptedEmail,
  sendOTPEmail,
  sendDeliveryConfirmationEmail,
  sendNGOVerifiedEmail,
  getSmtpStatus,
};
