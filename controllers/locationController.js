const catchAsync = require('../utils/catchAsync');
const {
  getCountries,
  getStates,
  getCities,
  validateCityState,
  generateCitySlug,
} = require('../data/indiaLocations');

/**
 * GET /api/v1/location/countries
 * Returns all supported countries.
 */
exports.getCountries = catchAsync(async (_req, res) => {
  res.status(200).json({
    status: 'success',
    data: { countries: getCountries() },
  });
});

/**
 * GET /api/v1/location/states?country=IN
 * Returns all states for a country.
 */
exports.getStatesList = catchAsync(async (req, res) => {
  const { country = 'IN' } = req.query;
  const states = getStates(country);

  res.status(200).json({
    status: 'success',
    results: states.length,
    data: { states },
  });
});

/**
 * GET /api/v1/location/cities?state=MH
 * Returns all cities for a state.
 */
exports.getCitiesList = catchAsync(async (req, res) => {
  const { state } = req.query;

  if (!state) {
    return res.status(400).json({
      status: 'fail',
      message: 'State code is required (e.g., ?state=MH)',
    });
  }

  const cities = getCities(state);

  res.status(200).json({
    status: 'success',
    results: cities.length,
    data: { cities },
  });
});

/**
 * POST /api/v1/location/validate
 * Validate a city-state-country combination.
 * Body: { city: "Mumbai", state: "MH", country: "IN" }
 */
exports.validateLocation = catchAsync(async (req, res) => {
  const { city, state, country = 'IN' } = req.body;

  if (!city || !state) {
    return res.status(400).json({
      status: 'fail',
      message: 'City and state are required.',
    });
  }

  if (country !== 'IN') {
    return res.status(400).json({
      status: 'fail',
      message: 'Only India (IN) is currently supported.',
    });
  }

  const slug = generateCitySlug(city);
  const result = validateCityState(slug, state);

  if (!result.valid) {
    return res.status(400).json({
      status: 'fail',
      message: result.reason,
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      city: result.city.name,
      citySlug: result.city.slug,
      state: result.state.name,
      stateCode: result.state.code,
      regionCode: result.state.regionCode,
      coordinates: { lat: result.city.lat, lng: result.city.lng },
    },
  });
});
