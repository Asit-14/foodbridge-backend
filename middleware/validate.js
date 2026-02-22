const { validationResult } = require('express-validator');
const { ValidationError } = require('../utils/AppError');

/**
 * Middleware that checks express-validator results
 * and returns an RFC 7807 validation error if there are errors.
 */
const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const fieldErrors = errors.array().map((e) => ({
      field: e.path,
      message: e.msg,
    }));

    return next(new ValidationError('Validation failed.', fieldErrors));
  }
  next();
};

module.exports = validate;
