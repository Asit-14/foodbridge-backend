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
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  client: {
    url: process.env.CLIENT_URL || 'http://localhost:5173',
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },

  get isDev() {
    return this.nodeEnv === 'development';
  },
  get isProd() {
    return this.nodeEnv === 'production';
  },
};

// ── Validate critical vars at startup ──────────────
const required = ['mongo.uri', 'jwt.secret', 'jwt.refreshSecret'];

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
if (env.jwt.refreshSecret.length < 32) {
  console.error('FATAL: JWT_REFRESH_SECRET must be at least 32 characters.');
  process.exit(1);
}

module.exports = env;
