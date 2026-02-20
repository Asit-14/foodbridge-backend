const { Router } = require('express');
const { query } = require('express-validator');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/locationController');

const router = Router();

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                   LOCATION ROUTES                           ║
 * ║                                                             ║
 * ║  Public endpoints for location data:                        ║
 * ║  - Countries, States, Cities dropdown data                  ║
 * ║  - City-state validation                                    ║
 * ║  No authentication required (used at registration)          ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// GET /api/v1/location/countries
router.get('/countries', ctrl.getCountries);

// GET /api/v1/location/states?country=IN
router.get(
  '/states',
  [
    query('country').optional().trim().isLength({ min: 2, max: 2 }),
  ],
  validate,
  ctrl.getStatesList
);

// GET /api/v1/location/cities?state=MH
router.get(
  '/cities',
  [
    query('state')
      .notEmpty().withMessage('State code is required')
      .trim()
      .isLength({ min: 2, max: 3 }).withMessage('Invalid state code'),
  ],
  validate,
  ctrl.getCitiesList
);

// POST /api/v1/location/validate
router.post('/validate', ctrl.validateLocation);

module.exports = router;
