/**
 * Custom operational error class.
 * All known/expected errors should be thrown as AppError instances.
 * The global error handler treats these differently from programmer errors.
 */
class AppError extends Error {
  /**
   * @param {string} message  Human-readable error message
   * @param {number} statusCode  HTTP status code (4xx / 5xx)
   */
  constructor(message, statusCode) {
    super(message);

    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;

    // Capture stack trace without this constructor in it
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
