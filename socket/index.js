const jwt = require('jsonwebtoken');
const env = require('../config/env');
const logger = require('../utils/logger');
const notificationService = require('../services/notificationService');

/**
 * Initialize Socket.io with JWT authentication.
 *
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
function initSocket(httpServer) {
  const { Server } = require('socket.io');

  const allowedOrigins = [
    env.client.url.replace(/\/+$/, ''),
    ...(process.env.EXTRA_ORIGINS || '').split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean),
  ];

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
  });

  // ── Auth middleware ────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, env.jwt.secret);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  // ── Connection handler ─────────────────────────────
  io.on('connection', (socket) => {
    const { userId, userRole } = socket;
    logger.info(`Socket connected: user=${userId} role=${userRole}`);

    // Join personal room for targeted notifications
    socket.join(`user:${userId}`);

    // Join role-level room for broadcasts
    socket.join(`role:${userRole}`);

    // NGOs can listen to a city room (sent from client after login)
    socket.on('join:city', (city) => {
      if (city && typeof city === 'string') {
        socket.join(`city:${city.toLowerCase()}`);
        logger.debug(`User ${userId} joined city room: ${city}`);
      }
    });

    // Join a specific donation room (for live tracking)
    socket.on('join:donation', (donationId) => {
      if (donationId) {
        socket.join(`donation:${donationId}`);
      }
    });

    socket.on('disconnect', (reason) => {
      logger.debug(`Socket disconnected: user=${userId} reason=${reason}`);
    });
  });

  // Inject IO into notification service so it can emit events
  notificationService.setIO(io);

  logger.info('Socket.io initialized');
  return io;
}

module.exports = initSocket;
