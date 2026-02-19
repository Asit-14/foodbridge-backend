const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
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

// ── Express app ────────────────────────────────────
const app = express();

// ── Global middleware ──────────────────────────────

// Security headers
app.use(helmet());

// Gzip/Brotli compression for all responses
app.use(compression());

// CORS
app.use(
  cors({
    origin: env.client.url,
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

// ── 404 handler ────────────────────────────────────
app.all('*', (req, _res, next) => {
  next(new AppError(`Route ${req.originalUrl} not found`, 404));
});

// ── Global error handler (must be last) ────────────
app.use(errorHandler);

module.exports = app;
