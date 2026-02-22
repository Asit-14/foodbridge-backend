const dotenv = require('dotenv');
const path = require('path');

// Load .env before anything else
dotenv.config({ path: path.join(__dirname, '..', '.env') });

/**
 * Centralized environment config.
 * Every module reads from here — never from process.env directly.
 */
const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,

  mongo: {
    uri: process.env.MONGO_URI,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  },

  client: {
    url: process.env.CLIENT_URL || 'http://localhost:5173',
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },

  sms: {
    provider: process.env.SMS_PROVIDER || '',
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    apiKey: process.env.FAST2SMS_API_KEY || '',
  },

  get isDev() {
    return this.nodeEnv === 'development';
  },
  get isProd() {
    return this.nodeEnv === 'production';
  },
  get isTest() {
    return this.nodeEnv === 'test';
  },
};

// ── Validate critical vars at startup ──────────────
const required = ['mongo.uri', 'jwt.secret'];

for (const key of required) {
  const value = key.split('.').reduce((o, k) => o?.[k], env);
  if (!value) {
    console.error(`FATAL: Missing environment variable mapped to env.${key}`);
    process.exit(1);
  }
}

// ── Validate JWT secret strength ────────────────
if (env.jwt.secret.length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters. Generate with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

// ── Warn about critical production misconfig ────
if (env.isProd) {
  if (env.client.url.includes('localhost')) {
    console.error('WARNING: CLIENT_URL contains "localhost" in production mode. CORS will reject your frontend. Set CLIENT_URL to your Vercel domain (e.g. https://your-app.vercel.app)');
  }
}

module.exports = env;
