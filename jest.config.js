/**
 * Jest configuration for FoodBridge server tests.
 */

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  maxWorkers: 1,
  testTimeout: 30000,
  forceExit: true,
  detectOpenHandles: true,
  silent: true,

  // Transform otplib and its ESM dependencies so Jest can load them
  transformIgnorePatterns: [
    'node_modules/(?!(@otplib|otplib|@scure|@noble)/)',
  ],
  transform: {
    '^.+\\.[jt]s$': ['babel-jest', { presets: ['@babel/preset-env'] }],
  },

  collectCoverageFrom: [
    'controllers/**/*.js',
    'middleware/**/*.js',
    'models/**/*.js',
    'utils/**/*.js',
    '!**/node_modules/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
};
