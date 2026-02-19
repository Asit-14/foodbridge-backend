const mongoose = require('mongoose');
const logger = require('../utils/logger');
const env = require('./env');

/**
 * Connect to MongoDB Atlas with retry logic.
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(env.mongo.uri, {
      autoIndex: !env.isProd,
      maxPoolSize: env.isProd ? 50 : 10,
      minPoolSize: env.isProd ? 10 : 2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    logger.info(`MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    logger.error(`MongoDB connection error: ${err.message}`);
    process.exit(1);
  }

  mongoose.connection.on('error', (err) => {
    logger.error(`MongoDB runtime error: ${err.message}`);
  });
};

module.exports = connectDB;
