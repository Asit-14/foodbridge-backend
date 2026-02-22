const logger = require('../utils/logger');
const env = require('../config/env');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║               GLOBAL ERROR HANDLER                           ║
 * ║                                                              ║
 * ║  Centralized error handling with:                            ║
 * ║  - Environment-aware responses (dev vs prod)                 ║
 * ║  - Error transformation for common issues                    ║
 * ║  - Security: Never leak stack traces in production           ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

/**
 * Global Express error handler.
 * Must have 4 params so Express recognizes it as an error handler.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
  // Default values
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  // ── Log with correlation ID ────────────────────────
  const reqId = req.id || 'unknown';
  if (err.statusCode >= 500) {
    logger.error(`[${reqId}] ${err.statusCode} — ${err.message}`, { stack: err.stack, requestId: reqId });
  } else {
    logger.warn(`[${reqId}] ${err.statusCode} — ${err.message}`, { requestId: reqId });
  }

  // ── Development: send full error ─────────────────
  if (env.isDev) {
    return res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
      errors: err.errors || undefined,
      stack: err.stack,
    });
  }

  // ── Production: sanitize known errors ────────────

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      status: 'fail',
      message: 'Invalid token. Please log in again.',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      status: 'fail',
      message: 'Token expired. Please log in again.',
    });
  }

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    return res.status(400).json({
      status: 'fail',
      message: `Invalid ${err.path}: ${err.value}`,
    });
  }

  // Mongoose duplicate key — generic message to prevent field name leakage
  if (err.code === 11000) {
    return res.status(409).json({
      status: 'fail',
      message: 'A record with this value already exists.',
    });
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      status: 'fail',
      message: 'Validation failed',
      errors: messages,
    });
  }

  // Operational errors (our own AppError instances)
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
      errors: err.errors || undefined,
    });
  }

  // Unknown / programmer error — don't leak details
  return res.status(500).json({
    status: 'error',
    message: 'Something went wrong. Please try again later.',
  });
};

module.exports = errorHandler;
