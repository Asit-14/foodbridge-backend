const { Router } = require('express');
const { SHELF_LIFE, FOOD_CATEGORIES, UNITS, DEFAULT_MAP_CENTER, DEFAULT_SEARCH_RADIUS_KM } = require('../utils/constants');

const router = Router();

router.get('/client-config', (_req, res) => {
  res.json({
    status: 'success',
    data: { SHELF_LIFE, FOOD_CATEGORIES, UNITS, DEFAULT_MAP_CENTER, DEFAULT_SEARCH_RADIUS_KM },
  });
});

module.exports = router;
