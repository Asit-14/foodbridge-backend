const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const logger = require('./utils/logger');
const requestId = require('./middleware/requestId');
const { apiLimiter } = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');
const AppError = require('./utils/AppError');
const { getStatus: getCronStatus } = require('./services/cronService');

// ── Route imports ──────────────────────────────────
const authRoutes = require('./routes/auth.routes');
const donationRoutes = require('./routes/donation.routes');
const adminRoutes = require('./routes/admin.routes');
const notificationRoutes = require('./routes/notification.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const locationRoutes = require('./routes/location.routes');
const configRoutes = require('./routes/config.routes');

// ── Express app ────────────────────────────────────
const app = express();

// ── Startup debug info ───────────────────────────
logger.info(`[DEBUG] App starting — NODE_ENV=${env.nodeEnv}, isProd=${env.isProd}, CLIENT_URL=${env.client.url}, SMTP_HOST=${env.smtp.host || 'NOT SET'}`);

// ── Global middleware ──────────────────────────────

// Security headers
app.use(helmet());

// Request correlation IDs for log tracing
app.use(requestId);

// Gzip/Brotli compression for all responses
app.use(compression());

// CORS — validate origin with logging for cross-origin debugging
// Supports multiple origins: CLIENT_URL + EXTRA_ORIGINS (comma-separated)
const allowedOrigins = [
  env.client.url.replace(/\/+$/, ''),
  ...(process.env.EXTRA_ORIGINS || '').split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean),
];
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (Postman, server-to-server, health checks)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      logger.warn(`CORS blocked request from origin: ${origin} (allowed: ${allowedOrigins.join(', ')})`);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Body parsers
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// Sanitize data — prevent NoSQL injection
app.use(mongoSanitize());

// HTTP request logging
if (env.isDev) {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Rate limiting
app.use('/api', apiLimiter);

// ── Health check ───────────────────────────────────
app.get('/api/health', async (_req, res) => {
  // Quick DB ping (admin command, <100ms on healthy connection)
  let dbStatus = 'disconnected';
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().ping();
      dbStatus = 'connected';
    }
  } catch {
    dbStatus = 'error';
  }

  const uptimeSec = Math.floor(process.uptime());
  const mem = process.memoryUsage();

  res.status(dbStatus === 'connected' ? 200 : 503).json({
    status: dbStatus === 'connected' ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`,
    database: dbStatus,
    memory: {
      rss: `${Math.round(mem.rss / 1048576)}MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1048576)}MB`,
    },
    cron: getCronStatus(),
  });
});

// ── API routes ─────────────────────────────────────
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/donations', donationRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/location', locationRoutes);
app.use('/api/v1/config', configRoutes);

// ── Root route (API info) ──────────────────────────
app.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'FoodBridge API is running',
    version: 'v1',
    docs: '/api/health',
  });
});

// ── 404 handler ────────────────────────────────────
app.all('*', (req, _res, next) => {
  next(new AppError(`Route ${req.originalUrl} not found`, 404));
});

// ── Global error handler (must be last) ────────────
app.use(errorHandler);

module.exports = app;
