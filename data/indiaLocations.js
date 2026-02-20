/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           INDIA LOCATIONS DATASET                           ║
 * ║                                                             ║
 * ║  Structured state → city mapping with:                      ║
 * ║  - Normalized slugs for indexed queries                     ║
 * ║  - Region codes (N/S/E/W/C/NE) for expansion               ║
 * ║  - Representative coordinates per city                      ║
 * ║  - Scalable to multi-country via country wrapper            ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const COUNTRIES = [
  { code: 'IN', name: 'India' },
];

/**
 * Region codes for state-level grouping.
 * Enables "nearby states" expansion when no city match exists.
 */
const REGIONS = {
  NORTH: 'N',
  SOUTH: 'S',
  EAST: 'E',
  WEST: 'W',
  CENTRAL: 'C',
  NORTHEAST: 'NE',
};

/**
 * States with their region codes.
 * regionCode enables state-proximity expansion in matching.
 */
const STATES = [
  { name: 'Andhra Pradesh', code: 'AP', regionCode: REGIONS.SOUTH },
  { name: 'Arunachal Pradesh', code: 'AR', regionCode: REGIONS.NORTHEAST },
  { name: 'Assam', code: 'AS', regionCode: REGIONS.NORTHEAST },
  { name: 'Bihar', code: 'BR', regionCode: REGIONS.EAST },
  { name: 'Chhattisgarh', code: 'CG', regionCode: REGIONS.CENTRAL },
  { name: 'Delhi', code: 'DL', regionCode: REGIONS.NORTH },
  { name: 'Goa', code: 'GA', regionCode: REGIONS.WEST },
  { name: 'Gujarat', code: 'GJ', regionCode: REGIONS.WEST },
  { name: 'Haryana', code: 'HR', regionCode: REGIONS.NORTH },
  { name: 'Himachal Pradesh', code: 'HP', regionCode: REGIONS.NORTH },
  { name: 'Jharkhand', code: 'JH', regionCode: REGIONS.EAST },
  { name: 'Karnataka', code: 'KA', regionCode: REGIONS.SOUTH },
  { name: 'Kerala', code: 'KL', regionCode: REGIONS.SOUTH },
  { name: 'Madhya Pradesh', code: 'MP', regionCode: REGIONS.CENTRAL },
  { name: 'Maharashtra', code: 'MH', regionCode: REGIONS.WEST },
  { name: 'Manipur', code: 'MN', regionCode: REGIONS.NORTHEAST },
  { name: 'Meghalaya', code: 'ML', regionCode: REGIONS.NORTHEAST },
  { name: 'Mizoram', code: 'MZ', regionCode: REGIONS.NORTHEAST },
  { name: 'Nagaland', code: 'NL', regionCode: REGIONS.NORTHEAST },
  { name: 'Odisha', code: 'OD', regionCode: REGIONS.EAST },
  { name: 'Punjab', code: 'PB', regionCode: REGIONS.NORTH },
  { name: 'Rajasthan', code: 'RJ', regionCode: REGIONS.NORTH },
  { name: 'Sikkim', code: 'SK', regionCode: REGIONS.NORTHEAST },
  { name: 'Tamil Nadu', code: 'TN', regionCode: REGIONS.SOUTH },
  { name: 'Telangana', code: 'TG', regionCode: REGIONS.SOUTH },
  { name: 'Tripura', code: 'TR', regionCode: REGIONS.NORTHEAST },
  { name: 'Uttar Pradesh', code: 'UP', regionCode: REGIONS.NORTH },
  { name: 'Uttarakhand', code: 'UK', regionCode: REGIONS.NORTH },
  { name: 'West Bengal', code: 'WB', regionCode: REGIONS.EAST },
  { name: 'Chandigarh', code: 'CH', regionCode: REGIONS.NORTH },
  { name: 'Puducherry', code: 'PY', regionCode: REGIONS.SOUTH },
  { name: 'Jammu and Kashmir', code: 'JK', regionCode: REGIONS.NORTH },
  { name: 'Ladakh', code: 'LA', regionCode: REGIONS.NORTH },
];

/**
 * Cities indexed by state code.
 * Each city has: name, slug (lowercase, hyphenated), lat, lng.
 */
const CITIES = {
  AP: [
    { name: 'Visakhapatnam', slug: 'visakhapatnam', lat: 17.6868, lng: 83.2185 },
    { name: 'Vijayawada', slug: 'vijayawada', lat: 16.5062, lng: 80.6480 },
    { name: 'Guntur', slug: 'guntur', lat: 16.3067, lng: 80.4365 },
    { name: 'Nellore', slug: 'nellore', lat: 14.4426, lng: 79.9865 },
    { name: 'Tirupati', slug: 'tirupati', lat: 13.6288, lng: 79.4192 },
    { name: 'Rajahmundry', slug: 'rajahmundry', lat: 17.0005, lng: 81.8040 },
    { name: 'Kakinada', slug: 'kakinada', lat: 16.9891, lng: 82.2475 },
    { name: 'Kurnool', slug: 'kurnool', lat: 15.8281, lng: 78.0373 },
    { name: 'Anantapur', slug: 'anantapur', lat: 14.6819, lng: 77.6006 },
  ],
  AR: [
    { name: 'Itanagar', slug: 'itanagar', lat: 27.0844, lng: 93.6053 },
  ],
  AS: [
    { name: 'Guwahati', slug: 'guwahati', lat: 26.1445, lng: 91.7362 },
    { name: 'Silchar', slug: 'silchar', lat: 24.8333, lng: 92.7789 },
    { name: 'Dibrugarh', slug: 'dibrugarh', lat: 27.4728, lng: 94.9120 },
    { name: 'Jorhat', slug: 'jorhat', lat: 26.7509, lng: 94.2037 },
  ],
  BR: [
    { name: 'Patna', slug: 'patna', lat: 25.6093, lng: 85.1376 },
    { name: 'Gaya', slug: 'gaya', lat: 24.7955, lng: 85.0002 },
    { name: 'Bhagalpur', slug: 'bhagalpur', lat: 25.2425, lng: 86.9842 },
    { name: 'Muzaffarpur', slug: 'muzaffarpur', lat: 26.1209, lng: 85.3647 },
    { name: 'Darbhanga', slug: 'darbhanga', lat: 26.1542, lng: 85.8918 },
  ],
  CG: [
    { name: 'Raipur', slug: 'raipur', lat: 21.2514, lng: 81.6296 },
    { name: 'Bhilai', slug: 'bhilai', lat: 21.2094, lng: 81.3784 },
    { name: 'Bilaspur', slug: 'bilaspur-cg', lat: 22.0797, lng: 82.1409 },
    { name: 'Korba', slug: 'korba', lat: 22.3595, lng: 82.7501 },
  ],
  DL: [
    { name: 'New Delhi', slug: 'new-delhi', lat: 28.6139, lng: 77.2090 },
    { name: 'Delhi', slug: 'delhi', lat: 28.7041, lng: 77.1025 },
  ],
  GA: [
    { name: 'Panaji', slug: 'panaji', lat: 15.4909, lng: 73.8278 },
    { name: 'Margao', slug: 'margao', lat: 15.2832, lng: 73.9862 },
    { name: 'Vasco da Gama', slug: 'vasco-da-gama', lat: 15.3982, lng: 73.8113 },
  ],
  GJ: [
    { name: 'Ahmedabad', slug: 'ahmedabad', lat: 23.0225, lng: 72.5714 },
    { name: 'Surat', slug: 'surat', lat: 21.1702, lng: 72.8311 },
    { name: 'Vadodara', slug: 'vadodara', lat: 22.3072, lng: 73.1812 },
    { name: 'Rajkot', slug: 'rajkot', lat: 22.3039, lng: 70.8022 },
    { name: 'Gandhinagar', slug: 'gandhinagar', lat: 23.2156, lng: 72.6369 },
    { name: 'Bhavnagar', slug: 'bhavnagar', lat: 21.7645, lng: 72.1519 },
    { name: 'Jamnagar', slug: 'jamnagar', lat: 22.4707, lng: 70.0577 },
    { name: 'Junagadh', slug: 'junagadh', lat: 21.5222, lng: 70.4579 },
  ],
  HR: [
    { name: 'Gurugram', slug: 'gurugram', lat: 28.4595, lng: 77.0266 },
    { name: 'Faridabad', slug: 'faridabad', lat: 28.4089, lng: 77.3178 },
    { name: 'Panipat', slug: 'panipat', lat: 29.3909, lng: 76.9635 },
    { name: 'Ambala', slug: 'ambala', lat: 30.3782, lng: 76.7767 },
    { name: 'Karnal', slug: 'karnal', lat: 29.6857, lng: 76.9905 },
    { name: 'Hisar', slug: 'hisar', lat: 29.1492, lng: 75.7217 },
    { name: 'Rohtak', slug: 'rohtak', lat: 28.8955, lng: 76.5921 },
  ],
  HP: [
    { name: 'Shimla', slug: 'shimla', lat: 31.1048, lng: 77.1734 },
    { name: 'Dharamshala', slug: 'dharamshala', lat: 32.2190, lng: 76.3234 },
    { name: 'Mandi', slug: 'mandi', lat: 31.7088, lng: 76.9320 },
  ],
  JH: [
    { name: 'Ranchi', slug: 'ranchi', lat: 23.3441, lng: 85.3096 },
    { name: 'Jamshedpur', slug: 'jamshedpur', lat: 22.8046, lng: 86.2029 },
    { name: 'Dhanbad', slug: 'dhanbad', lat: 23.7957, lng: 86.4304 },
    { name: 'Bokaro', slug: 'bokaro', lat: 23.6693, lng: 86.1511 },
  ],
  KA: [
    { name: 'Bengaluru', slug: 'bengaluru', lat: 12.9716, lng: 77.5946 },
    { name: 'Mysuru', slug: 'mysuru', lat: 12.2958, lng: 76.6394 },
    { name: 'Mangaluru', slug: 'mangaluru', lat: 12.9141, lng: 74.8560 },
    { name: 'Hubli-Dharwad', slug: 'hubli-dharwad', lat: 15.3647, lng: 75.1240 },
    { name: 'Belgaum', slug: 'belgaum', lat: 15.8497, lng: 74.4977 },
    { name: 'Gulbarga', slug: 'gulbarga', lat: 17.3297, lng: 76.8343 },
    { name: 'Davangere', slug: 'davangere', lat: 14.4644, lng: 75.9218 },
    { name: 'Shimoga', slug: 'shimoga', lat: 13.9299, lng: 75.5681 },
  ],
  KL: [
    { name: 'Thiruvananthapuram', slug: 'thiruvananthapuram', lat: 8.5241, lng: 76.9366 },
    { name: 'Kochi', slug: 'kochi', lat: 9.9312, lng: 76.2673 },
    { name: 'Kozhikode', slug: 'kozhikode', lat: 11.2588, lng: 75.7804 },
    { name: 'Thrissur', slug: 'thrissur', lat: 10.5276, lng: 76.2144 },
    { name: 'Kollam', slug: 'kollam', lat: 8.8932, lng: 76.6141 },
    { name: 'Kannur', slug: 'kannur', lat: 11.8745, lng: 75.3704 },
  ],
  MP: [
    { name: 'Bhopal', slug: 'bhopal', lat: 23.2599, lng: 77.4126 },
    { name: 'Indore', slug: 'indore', lat: 22.7196, lng: 75.8577 },
    { name: 'Jabalpur', slug: 'jabalpur', lat: 23.1815, lng: 79.9864 },
    { name: 'Gwalior', slug: 'gwalior', lat: 26.2183, lng: 78.1828 },
    { name: 'Ujjain', slug: 'ujjain', lat: 23.1765, lng: 75.7885 },
    { name: 'Sagar', slug: 'sagar', lat: 23.8388, lng: 78.7378 },
  ],
  MH: [
    { name: 'Mumbai', slug: 'mumbai', lat: 19.0760, lng: 72.8777 },
    { name: 'Pune', slug: 'pune', lat: 18.5204, lng: 73.8567 },
    { name: 'Nagpur', slug: 'nagpur', lat: 21.1458, lng: 79.0882 },
    { name: 'Thane', slug: 'thane', lat: 19.2183, lng: 72.9781 },
    { name: 'Nashik', slug: 'nashik', lat: 19.9975, lng: 73.7898 },
    { name: 'Aurangabad', slug: 'aurangabad', lat: 19.8762, lng: 75.3433 },
    { name: 'Solapur', slug: 'solapur', lat: 17.6599, lng: 75.9064 },
    { name: 'Kolhapur', slug: 'kolhapur', lat: 16.7050, lng: 74.2433 },
    { name: 'Navi Mumbai', slug: 'navi-mumbai', lat: 19.0330, lng: 73.0297 },
    { name: 'Pimpri-Chinchwad', slug: 'pimpri-chinchwad', lat: 18.6279, lng: 73.8009 },
  ],
  MN: [
    { name: 'Imphal', slug: 'imphal', lat: 24.8170, lng: 93.9368 },
  ],
  ML: [
    { name: 'Shillong', slug: 'shillong', lat: 25.5788, lng: 91.8933 },
  ],
  MZ: [
    { name: 'Aizawl', slug: 'aizawl', lat: 23.7271, lng: 92.7176 },
  ],
  NL: [
    { name: 'Dimapur', slug: 'dimapur', lat: 25.9065, lng: 93.7273 },
    { name: 'Kohima', slug: 'kohima', lat: 25.6751, lng: 94.1086 },
  ],
  OD: [
    { name: 'Bhubaneswar', slug: 'bhubaneswar', lat: 20.2961, lng: 85.8245 },
    { name: 'Cuttack', slug: 'cuttack', lat: 20.4625, lng: 85.8830 },
    { name: 'Rourkela', slug: 'rourkela', lat: 22.2604, lng: 84.8536 },
    { name: 'Berhampur', slug: 'berhampur', lat: 19.3150, lng: 84.7941 },
    { name: 'Sambalpur', slug: 'sambalpur', lat: 21.4669, lng: 83.9812 },
  ],
  PB: [
    { name: 'Ludhiana', slug: 'ludhiana', lat: 30.9010, lng: 75.8573 },
    { name: 'Amritsar', slug: 'amritsar', lat: 31.6340, lng: 74.8723 },
    { name: 'Jalandhar', slug: 'jalandhar', lat: 31.3260, lng: 75.5762 },
    { name: 'Patiala', slug: 'patiala', lat: 30.3398, lng: 76.3869 },
    { name: 'Bathinda', slug: 'bathinda', lat: 30.2110, lng: 74.9455 },
    { name: 'Mohali', slug: 'mohali', lat: 30.7046, lng: 76.7179 },
  ],
  RJ: [
    { name: 'Jaipur', slug: 'jaipur', lat: 26.9124, lng: 75.7873 },
    { name: 'Jodhpur', slug: 'jodhpur', lat: 26.2389, lng: 73.0243 },
    { name: 'Udaipur', slug: 'udaipur', lat: 24.5854, lng: 73.7125 },
    { name: 'Kota', slug: 'kota', lat: 25.2138, lng: 75.8648 },
    { name: 'Ajmer', slug: 'ajmer', lat: 26.4499, lng: 74.6399 },
    { name: 'Bikaner', slug: 'bikaner', lat: 28.0229, lng: 73.3119 },
    { name: 'Alwar', slug: 'alwar', lat: 27.5530, lng: 76.6346 },
  ],
  SK: [
    { name: 'Gangtok', slug: 'gangtok', lat: 27.3389, lng: 88.6065 },
  ],
  TN: [
    { name: 'Chennai', slug: 'chennai', lat: 13.0827, lng: 80.2707 },
    { name: 'Coimbatore', slug: 'coimbatore', lat: 11.0168, lng: 76.9558 },
    { name: 'Madurai', slug: 'madurai', lat: 9.9252, lng: 78.1198 },
    { name: 'Tiruchirappalli', slug: 'tiruchirappalli', lat: 10.7905, lng: 78.7047 },
    { name: 'Salem', slug: 'salem', lat: 11.6643, lng: 78.1460 },
    { name: 'Tirunelveli', slug: 'tirunelveli', lat: 8.7139, lng: 77.7567 },
    { name: 'Erode', slug: 'erode', lat: 11.3410, lng: 77.7172 },
    { name: 'Vellore', slug: 'vellore', lat: 12.9165, lng: 79.1325 },
    { name: 'Thanjavur', slug: 'thanjavur', lat: 10.7870, lng: 79.1378 },
  ],
  TG: [
    { name: 'Hyderabad', slug: 'hyderabad', lat: 17.3850, lng: 78.4867 },
    { name: 'Warangal', slug: 'warangal', lat: 17.9784, lng: 79.5941 },
    { name: 'Nizamabad', slug: 'nizamabad', lat: 18.6725, lng: 78.0941 },
    { name: 'Karimnagar', slug: 'karimnagar', lat: 18.4386, lng: 79.1288 },
    { name: 'Khammam', slug: 'khammam', lat: 17.2473, lng: 80.1514 },
    { name: 'Secunderabad', slug: 'secunderabad', lat: 17.4399, lng: 78.4983 },
  ],
  TR: [
    { name: 'Agartala', slug: 'agartala', lat: 23.8315, lng: 91.2868 },
  ],
  UP: [
    { name: 'Lucknow', slug: 'lucknow', lat: 26.8467, lng: 80.9462 },
    { name: 'Kanpur', slug: 'kanpur', lat: 26.4499, lng: 80.3319 },
    { name: 'Agra', slug: 'agra', lat: 27.1767, lng: 78.0081 },
    { name: 'Varanasi', slug: 'varanasi', lat: 25.3176, lng: 82.9739 },
    { name: 'Prayagraj', slug: 'prayagraj', lat: 25.4358, lng: 81.8463 },
    { name: 'Meerut', slug: 'meerut', lat: 28.9845, lng: 77.7064 },
    { name: 'Noida', slug: 'noida', lat: 28.5355, lng: 77.3910 },
    { name: 'Ghaziabad', slug: 'ghaziabad', lat: 28.6692, lng: 77.4538 },
    { name: 'Bareilly', slug: 'bareilly', lat: 28.3670, lng: 79.4304 },
    { name: 'Aligarh', slug: 'aligarh', lat: 27.8974, lng: 78.0880 },
    { name: 'Moradabad', slug: 'moradabad', lat: 28.8386, lng: 78.7733 },
    { name: 'Gorakhpur', slug: 'gorakhpur', lat: 26.7606, lng: 83.3732 },
    { name: 'Greater Noida', slug: 'greater-noida', lat: 28.4744, lng: 77.5040 },
  ],
  UK: [
    { name: 'Dehradun', slug: 'dehradun', lat: 30.3165, lng: 78.0322 },
    { name: 'Haridwar', slug: 'haridwar', lat: 29.9457, lng: 78.1642 },
    { name: 'Rishikesh', slug: 'rishikesh', lat: 30.0869, lng: 78.2676 },
    { name: 'Haldwani', slug: 'haldwani', lat: 29.2183, lng: 79.5130 },
  ],
  WB: [
    { name: 'Kolkata', slug: 'kolkata', lat: 22.5726, lng: 88.3639 },
    { name: 'Howrah', slug: 'howrah', lat: 22.5958, lng: 88.2636 },
    { name: 'Durgapur', slug: 'durgapur', lat: 23.5204, lng: 87.3119 },
    { name: 'Asansol', slug: 'asansol', lat: 23.6739, lng: 86.9524 },
    { name: 'Siliguri', slug: 'siliguri', lat: 26.7271, lng: 88.3953 },
    { name: 'Kharagpur', slug: 'kharagpur', lat: 22.3460, lng: 87.2320 },
  ],
  CH: [
    { name: 'Chandigarh', slug: 'chandigarh', lat: 30.7333, lng: 76.7794 },
  ],
  PY: [
    { name: 'Puducherry', slug: 'puducherry', lat: 11.9416, lng: 79.8083 },
  ],
  JK: [
    { name: 'Srinagar', slug: 'srinagar', lat: 34.0837, lng: 74.7973 },
    { name: 'Jammu', slug: 'jammu', lat: 32.7266, lng: 74.8570 },
  ],
  LA: [
    { name: 'Leh', slug: 'leh', lat: 34.1526, lng: 77.5771 },
  ],
};

// ── Lookup helpers ─────────────────────────────────

/** Map of state code → state object */
const stateByCode = new Map(STATES.map((s) => [s.code, s]));

/** Map of state name (lowercase) → state object */
const stateByName = new Map(STATES.map((s) => [s.name.toLowerCase(), s]));

/** Map of city slug → { city, stateCode } */
const cityBySlug = new Map();
for (const [stateCode, cities] of Object.entries(CITIES)) {
  for (const city of cities) {
    cityBySlug.set(city.slug, { ...city, stateCode });
  }
}

/** Map of region code → array of state codes */
const statesByRegion = new Map();
for (const state of STATES) {
  if (!statesByRegion.has(state.regionCode)) {
    statesByRegion.set(state.regionCode, []);
  }
  statesByRegion.get(state.regionCode).push(state.code);
}

// ── Public API ─────────────────────────────────────

/**
 * Get all countries.
 */
function getCountries() {
  return COUNTRIES;
}

/**
 * Get all states for a country.
 * @param {string} countryCode - e.g. 'IN'
 */
function getStates(countryCode = 'IN') {
  if (countryCode !== 'IN') return [];
  return STATES.map((s) => ({ name: s.name, code: s.code, regionCode: s.regionCode }));
}

/**
 * Get cities for a state.
 * @param {string} stateCode - e.g. 'MH'
 */
function getCities(stateCode) {
  return CITIES[stateCode] || [];
}

/**
 * Generate a city slug from a city name.
 * @param {string} cityName
 * @returns {string} normalized slug
 */
function generateCitySlug(cityName) {
  return cityName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Validate that a city belongs to a state.
 * @param {string} citySlug
 * @param {string} stateCode
 * @returns {{ valid: boolean, city?: object, reason?: string }}
 */
function validateCityState(citySlug, stateCode) {
  const state = stateByCode.get(stateCode);
  if (!state) {
    return { valid: false, reason: `Invalid state code: ${stateCode}` };
  }

  const cities = CITIES[stateCode] || [];
  const city = cities.find((c) => c.slug === citySlug);
  if (!city) {
    return { valid: false, reason: `City "${citySlug}" not found in ${state.name}` };
  }

  return { valid: true, city, state };
}

/**
 * Find city data by slug.
 * @param {string} slug
 * @returns {{ city, stateCode } | null}
 */
function findCityBySlug(slug) {
  return cityBySlug.get(slug) || null;
}

/**
 * Get nearby state codes in the same region.
 * @param {string} stateCode
 * @returns {string[]} Array of state codes in the same region (excluding input)
 */
function getNearbyCitySlugs(stateCode) {
  const state = stateByCode.get(stateCode);
  if (!state) return [];

  const regionStates = statesByRegion.get(state.regionCode) || [];
  const slugs = [];
  for (const sc of regionStates) {
    if (sc === stateCode) continue;
    const cities = CITIES[sc] || [];
    for (const city of cities) {
      slugs.push(city.slug);
    }
  }
  return slugs;
}

/**
 * Get all city slugs within a state.
 * @param {string} stateCode
 * @returns {string[]}
 */
function getStateCitySlugs(stateCode) {
  const cities = CITIES[stateCode] || [];
  return cities.map((c) => c.slug);
}

/**
 * Get state info by state code.
 * @param {string} code
 */
function getStateByCode(code) {
  return stateByCode.get(code) || null;
}

module.exports = {
  COUNTRIES,
  STATES,
  CITIES,
  REGIONS,
  getCountries,
  getStates,
  getCities,
  generateCitySlug,
  validateCityState,
  findCityBySlug,
  getNearbyCitySlugs,
  getStateCitySlugs,
  getStateByCode,
};
