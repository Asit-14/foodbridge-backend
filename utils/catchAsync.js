/**
 * Wraps an async Express handler so we never need try/catch in controllers.
 * Any rejected promise is forwarded to Express's next(err).
 *
 * Usage:
 *   router.get('/items', catchAsync(async (req, res) => { ... }));
 */
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = catchAsync;
