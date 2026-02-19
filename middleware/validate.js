const { validationResult } = require('express-validator');
const AppError = require('../utils/AppError');

/**
 * Middleware that checks express-validator results
 * and returns a structured 400 if there are errors.
 *
 * Usage: place after an array of validation chains in routes.
 *   router.post('/', [...validators], validate, controller);
 */
const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map((e) => ({
      field: e.path,
      message: e.msg,
    }));

    return next(
      Object.assign(
        new AppError('Validation failed', 400),
        { errors: messages }
      )
    );
  }
  next();
};

module.exports = validate;
