const Notification = require('../models/Notification');
const logger = require('../utils/logger');

// Will be set by socket/index.js after server starts
let io = null;

/**
 * Inject the Socket.io instance so the service can emit events.
 */
function setIO(socketIO) {
  io = socketIO;
}

/**
 * Create a persistent notification AND push a real-time socket event.
 *
 * @param {Object} opts
 * @param {string} opts.recipientId  Mongoose ObjectId (string)
 * @param {string} opts.type         Notification type enum value
 * @param {string} opts.title        Short title
 * @param {string} opts.message      Body text
 * @param {Object} [opts.data]       Optional { donationId, link }
 */
async function notify({ recipientId, type, title, message, data }) {
  try {
    // 1. Persist to database
    const notification = await Notification.create({
      recipientId,
      type,
      title,
      message,
      data: data || {},
    });

    // 2. Push via Socket.io (if connected)
    if (io) {
      io.to(`user:${recipientId}`).emit('notification', {
        _id: notification._id,
        type,
        title,
        message,
        data,
        createdAt: notification.createdAt,
      });
    }

    logger.debug(`Notification sent: [${type}] → user ${recipientId}`);
  } catch (err) {
    // Notification failures should not crash the caller
    logger.error(`Failed to send notification: ${err.message}`);
  }
}

/**
 * Broadcast an event to a Socket.io room (e.g., all NGOs in a city).
 */
function broadcast(room, event, payload) {
  if (io) {
    io.to(room).emit(event, payload);
  }
}

module.exports = { setIO, notify, broadcast };
