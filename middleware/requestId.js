const crypto = require('crypto');

/**
 * Attach a unique correlation ID to every request.
 * Used for log tracing and error diagnostics.
 */
function requestId(req, _res, next) {
  req.id = crypto.randomUUID();
  next();
}

module.exports = requestId;
