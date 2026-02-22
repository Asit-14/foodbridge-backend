const logger = require('../utils/logger');
const env = require('../config/env');
const {
  BaseError,
  ValidationError,
  AuthenticationError,
  ConflictError,
} = require('../utils/AppError');

const ERROR_BASE_URI = 'https://foodbridge.api/errors';

/**
 * Build an RFC 7807 Problem Details response body.
 */
function problemJson(req, { type, title, status, detail, errorCode, errors, retryAfter, stack }) {
  const body = {
    type,
    title,
    status,
    detail,
    instance: req.originalUrl,
    errorCode,
    requestId: req.id || 'unknown',
  };

  if (errors) body.errors = errors;
  if (retryAfter) body.retryAfter = retryAfter;
  if (env.isDev && stack) body.stack = stack;

  return body;
}

/**
 * Global Express error handler (RFC 7807).
 * Must have 4 params so Express recognizes it as an error handler.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
  const reqId = req.id || 'unknown';

  // ── Our own BaseError instances ─────────────────────
  if (err instanceof BaseError) {
    if (err.status >= 500) {
      logger.error(`[${reqId}] ${err.status} — ${err.detail}`, { stack: err.stack, requestId: reqId });
    } else {
      logger.warn(`[${reqId}] ${err.status} — ${err.detail}`, { requestId: reqId });
    }

    return res.status(err.status).json(
      problemJson(req, {
        type: err.type,
        title: err.title,
        status: err.status,
        detail: err.detail,
        errorCode: err.errorCode,
        errors: err.errors,
        retryAfter: err.retryAfter,
        stack: err.stack,
      })
    );
  }

  // ── JWT errors ─────────────────────────────────────
  if (err.name === 'JsonWebTokenError') {
    logger.warn(`[${reqId}] 401 — Invalid token`, { requestId: reqId });
    const mapped = new AuthenticationError('Invalid token. Please log in again.');
    return res.status(401).json(problemJson(req, { ...mapped, stack: err.stack }));
  }

  if (err.name === 'TokenExpiredError') {
    logger.warn(`[${reqId}] 401 — Token expired`, { requestId: reqId });
    const mapped = new AuthenticationError('Token expired. Please log in again.');
    return res.status(401).json(problemJson(req, { ...mapped, stack: err.stack }));
  }

  // ── Mongoose CastError (bad ObjectId) ──────────────
  if (err.name === 'CastError') {
    logger.warn(`[${reqId}] 400 — Invalid ${err.path}: ${err.value}`, { requestId: reqId });
    const mapped = new ValidationError(`Invalid ${err.path}: ${err.value}`);
    return res.status(400).json(problemJson(req, { ...mapped, stack: err.stack }));
  }

  // ── Mongoose duplicate key ─────────────────────────
  if (err.code === 11000) {
    logger.warn(`[${reqId}] 409 — Duplicate key`, { requestId: reqId });
    const mapped = new ConflictError('A record with this value already exists.');
    return res.status(409).json(problemJson(req, { ...mapped, stack: err.stack }));
  }

  // ── Mongoose validation error ──────────────────────
  if (err.name === 'ValidationError' && err.errors) {
    const fieldErrors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    logger.warn(`[${reqId}] 400 — Mongoose validation failed`, { requestId: reqId });
    const mapped = new ValidationError('Validation failed.', fieldErrors);
    return res.status(400).json(problemJson(req, { ...mapped, stack: err.stack }));
  }

  // ── Unknown / programmer error ─────────────────────
  const status = err.statusCode || err.status || 500;
  if (status >= 500) {
    logger.error(`[${reqId}] ${status} — ${err.message}`, { stack: err.stack, requestId: reqId });
  } else {
    logger.warn(`[${reqId}] ${status} — ${err.message}`, { requestId: reqId });
  }

  return res.status(status).json(
    problemJson(req, {
      type: `${ERROR_BASE_URI}/internal-error`,
      title: 'Internal Server Error',
      status,
      detail: status >= 500 ? 'Something went wrong. Please try again later.' : err.message,
      errorCode: 'INTERNAL_ERROR',
      stack: err.stack,
    })
  );
};

module.exports = errorHandler;
