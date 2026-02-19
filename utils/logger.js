const { createLogger, format, transports } = require('winston');
const env = require('../config/env');

const prodTransports = [
  new transports.Console(),
  new transports.File({ filename: 'logs/error.log', level: 'error', maxsize: 5242880, maxFiles: 5 }),
  new transports.File({ filename: 'logs/combined.log', maxsize: 5242880, maxFiles: 5 }),
];

const devTransports = [new transports.Console()];

const logger = createLogger({
  level: env.isDev ? 'debug' : 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    env.isDev
      ? format.combine(format.colorize(), format.simple())
      : format.json()
  ),
  defaultMeta: { service: 'food-waste-api' },
  transports: env.isProd ? prodTransports : devTransports,
});

module.exports = logger;
