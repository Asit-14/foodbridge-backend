const { createLogger, format, transports } = require('winston');
const env = require('../config/env');

// Production: console-only (Render/Railway/Fly have ephemeral filesystems —
// file transports waste I/O and logs are lost on every deploy/restart).
// Platform log aggregation captures stdout/stderr automatically.
const prodTransports = [
  new transports.Console(),
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
