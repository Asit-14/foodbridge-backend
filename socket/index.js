const env = require('../config/env');
const logger = require('../utils/logger');
const { verifyAccessToken } = require('../utils/jwtUtils');
const User = require('../models/User');
const notificationService = require('../services/notificationService');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              SOCKET.IO INITIALIZATION                        ║
 * ║                                                              ║
 * ║  Hardened socket authentication with:                        ║
 * ║  - Full JWT verification (algorithm, issuer, audience)       ║
 * ║  - User existence and active status checks                   ║
 * ║  - tokenVersion validation                                   ║
 * ║  - Room-based broadcasting for notifications                 ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

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

  // ── Auth middleware — full security validation ──────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      // Use the same verifyAccessToken that enforces algorithm, issuer, audience
      const decoded = verifyAccessToken(token);

      // Verify user exists and is active
      const user = await User.findById(decoded.id);
      if (!user) {
        return next(new Error('User not found'));
      }

      if (!user.isActive) {
        return next(new Error('Account deactivated'));
      }

      // Verify tokenVersion matches (catches forced revocations)
      if ((decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
        return next(new Error('Token revoked'));
      }

      // Check password wasn't changed after token was issued
      if (user.changedPasswordAfter(decoded.iat)) {
        return next(new Error('Password changed'));
      }

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
      if (city && typeof city === 'string' && city.length <= 100) {
        socket.join(`city:${city.toLowerCase()}`);
      }
    });

    // Join a specific donation room (for live tracking)
    socket.on('join:donation', (donationId) => {
      if (donationId && typeof donationId === 'string' && donationId.length <= 24) {
        socket.join(`donation:${donationId}`);
      }
    });

    socket.on('disconnect', (reason) => {
      logger.debug(`Socket disconnected: user=${userId} reason=${reason}`);
    });
  });

  // Inject IO into notification service so it can emit events
  notificationService.setIO(io);

  logger.info('Socket.io initialized with hardened JWT authentication');
  return io;
}

module.exports = initSocket;
