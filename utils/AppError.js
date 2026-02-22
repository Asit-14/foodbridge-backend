/**
 * RFC 7807 Problem Details error classes.
 *
 * Every operational error thrown in this codebase should be an instance
 * of one of these classes.  The global error handler serialises them
 * into the standard { type, title, status, detail, instance, ... } shape.
 */

const ERROR_BASE_URI = 'https://foodbridge.api/errors';

// ── Base class ──────────────────────────────────────────
class BaseError extends Error {
  /**
   * @param {object}  opts
   * @param {string}  opts.type       RFC 7807 type slug (appended to ERROR_BASE_URI)
   * @param {string}  opts.title      Short, human-readable summary
   * @param {number}  opts.status     HTTP status code
   * @param {string}  opts.detail     Longer explanation (shown to end-user)
   * @param {string}  opts.errorCode  Machine-readable code (e.g. VALIDATION_ERROR)
   * @param {Array}   [opts.errors]   Field-level validation errors
   */
  constructor({ type, title, status, detail, errorCode, errors }) {
    super(detail);

    this.type = `${ERROR_BASE_URI}/${type}`;
    this.title = title;
    this.status = status;
    this.detail = detail;
    this.errorCode = errorCode;
    this.isOperational = true;

    if (errors) this.errors = errors;

    Error.captureStackTrace(this, this.constructor);
  }

  /** Keeps backward compat with code that reads .statusCode */
  get statusCode() {
    return this.status;
  }
}

// ── Derived classes ─────────────────────────────────────

class ValidationError extends BaseError {
  constructor(detail = 'One or more fields failed validation.', errors) {
    super({
      type: 'validation-error',
      title: 'Validation Error',
      status: 400,
      detail,
      errorCode: 'VALIDATION_ERROR',
      errors,
    });
  }
}

class AuthenticationError extends BaseError {
  constructor(detail = 'Authentication required. Please log in.') {
    super({
      type: 'authentication-error',
      title: 'Authentication Error',
      status: 401,
      detail,
      errorCode: 'AUTHENTICATION_ERROR',
    });
  }
}

class AuthorizationError extends BaseError {
  constructor(detail = 'You do not have permission to perform this action.') {
    super({
      type: 'authorization-error',
      title: 'Authorization Error',
      status: 403,
      detail,
      errorCode: 'AUTHORIZATION_ERROR',
    });
  }
}

class NotFoundError extends BaseError {
  constructor(detail = 'The requested resource was not found.') {
    super({
      type: 'not-found',
      title: 'Not Found',
      status: 404,
      detail,
      errorCode: 'NOT_FOUND',
    });
  }
}

class ConflictError extends BaseError {
  constructor(detail = 'A record with this value already exists.') {
    super({
      type: 'conflict',
      title: 'Conflict',
      status: 409,
      detail,
      errorCode: 'CONFLICT',
    });
  }
}

class RateLimitError extends BaseError {
  /**
   * @param {string} detail
   * @param {number} [retryAfter]  Seconds until the client can retry
   */
  constructor(detail = 'Too many requests. Please try again later.', retryAfter) {
    super({
      type: 'rate-limit',
      title: 'Too Many Requests',
      status: 429,
      detail,
      errorCode: 'RATE_LIMIT',
    });
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

module.exports = {
  BaseError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
};
