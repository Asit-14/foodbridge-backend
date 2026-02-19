const { body, param, query } = require('express-validator');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              VALIDATION SCHEMAS                              ║
 * ║                                                              ║
 * ║  Centralized validation rules for reuse across routes.       ║
 * ║  Based on express-validator with custom validators.          ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── Common Field Validators ────────────────────────

const commonValidators = {
  // MongoDB ObjectId validation
  objectId: (field = 'id', location = 'param') => {
    const validator = location === 'param' ? param(field) : body(field);
    return validator
      .trim()
      .notEmpty().withMessage(`${field} is required`)
      .isMongoId().withMessage(`Invalid ${field} format`);
  },

  // Email validation
  email: (required = true) => {
    let validator = body('email')
      .trim()
      .isEmail().withMessage('Please provide a valid email')
      .isLength({ max: 254 }).withMessage('Email must not exceed 254 characters')
      .normalizeEmail({
        gmail_remove_dots: false,
        gmail_remove_subaddress: false,
      });

    if (required) {
      validator = validator.notEmpty().withMessage('Email is required');
    } else {
      validator = body('email').optional().trim().isEmail();
    }

    return validator;
  },

  // Name validation
  name: (field = 'name', required = true) => {
    let validator = body(field)
      .trim()
      .isLength({ min: 2, max: 100 }).withMessage(`${field} must be between 2 and 100 characters`)
      .matches(/^[a-zA-Z\s'-]+$/).withMessage(`${field} can only contain letters, spaces, hyphens, and apostrophes`);

    if (required) {
      validator = validator.notEmpty().withMessage(`${field} is required`);
    }

    return validator;
  },

  // Phone validation
  phone: (required = false) => {
    let validator = body('phone')
      .trim()
      .isMobilePhone('any', { strictMode: false }).withMessage('Invalid phone number');

    if (!required) {
      validator = body('phone').optional().trim().isMobilePhone('any');
    }

    return validator;
  },

  // Pagination
  pagination: [
    query('page')
      .optional()
      .isInt({ min: 1 }).withMessage('Page must be a positive integer')
      .toInt(),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100')
      .toInt(),
    query('sort')
      .optional()
      .trim()
      .matches(/^[a-zA-Z_]+$/).withMessage('Invalid sort field'),
    query('order')
      .optional()
      .isIn(['asc', 'desc']).withMessage('Order must be asc or desc'),
  ],

  // Date validation
  date: (field, required = false) => {
    let validator = body(field)
      .isISO8601().withMessage(`${field} must be a valid date`)
      .toDate();

    if (required) {
      validator = validator.notEmpty().withMessage(`${field} is required`);
    } else {
      validator = body(field).optional().isISO8601().toDate();
    }

    return validator;
  },

  // Coordinates (GeoJSON)
  coordinates: (required = false) => {
    const validators = [
      body('location.coordinates')
        .optional()
        .isArray({ min: 2, max: 2 }).withMessage('Coordinates must be [longitude, latitude]'),
      body('location.coordinates.0')
        .optional()
        .isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),
      body('location.coordinates.1')
        .optional()
        .isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
    ];

    if (required) {
      validators[0] = body('location.coordinates')
        .notEmpty().withMessage('Location coordinates are required')
        .isArray({ min: 2, max: 2 }).withMessage('Coordinates must be [longitude, latitude]');
    }

    return validators;
  },
};

// ── Password Validators ────────────────────────────

const passwordValidators = {
  // Standard password requirements
  password: (field = 'password') =>
    body(field)
      .notEmpty().withMessage('Password is required')
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
      .isLength({ max: 128 }).withMessage('Password must not exceed 128 characters')
      .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
      .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
      .matches(/\d/).withMessage('Password must contain at least one number')
      .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Password must contain at least one special character')
      .not().matches(/\s/).withMessage('Password must not contain spaces'),

  // New password (different from current)
  newPassword: body('newPassword')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
    .isLength({ max: 128 }).withMessage('New password must not exceed 128 characters')
    .matches(/[a-z]/).withMessage('New password must contain at least one lowercase letter')
    .matches(/[A-Z]/).withMessage('New password must contain at least one uppercase letter')
    .matches(/\d/).withMessage('New password must contain at least one number')
    .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('New password must contain at least one special character')
    .custom((value, { req }) => {
      if (value === req.body.currentPassword) {
        throw new Error('New password must be different from current password');
      }
      return true;
    }),

  // Password confirmation
  confirmPassword: body('confirmPassword')
    .notEmpty().withMessage('Password confirmation is required')
    .custom((value, { req }) => {
      const passwordField = req.body.newPassword || req.body.password;
      if (value !== passwordField) {
        throw new Error('Passwords do not match');
      }
      return true;
    }),

  // Current password (for password change)
  currentPassword: body('currentPassword')
    .notEmpty().withMessage('Current password is required'),
};

// ── Token Validators ───────────────────────────────

const tokenValidators = {
  // Hex token (64 chars - SHA256)
  hexToken: (location = 'param') => {
    const validator = location === 'param' ? param('token') : body('token');
    return validator
      .trim()
      .notEmpty().withMessage('Token is required')
      .isLength({ min: 64, max: 64 }).withMessage('Invalid token format')
      .isHexadecimal().withMessage('Invalid token format');
  },

  // UUID token
  uuidToken: (location = 'param') => {
    const validator = location === 'param' ? param('token') : body('token');
    return validator
      .trim()
      .notEmpty().withMessage('Token is required')
      .isUUID().withMessage('Invalid token format');
  },
};

// ── Role Validators ────────────────────────────────

const roleValidators = {
  // User role (registration)
  userRole: body('role')
    .notEmpty().withMessage('Role is required')
    .isIn(['donor', 'ngo']).withMessage('Role must be donor or ngo'),

  // Admin-only role assignment
  adminRole: body('role')
    .optional()
    .isIn(['donor', 'ngo', 'admin']).withMessage('Invalid role'),
};

// ── Sanitizers ─────────────────────────────────────

const sanitizers = {
  // Trim all string fields in body
  trimStrings: (req, _res, next) => {
    const trimValue = (obj) => {
      for (const key in obj) {
        if (typeof obj[key] === 'string') {
          obj[key] = obj[key].trim();
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          trimValue(obj[key]);
        }
      }
    };
    trimValue(req.body);
    next();
  },

  // Lowercase email
  lowercaseEmail: (req, _res, next) => {
    if (req.body.email) {
      req.body.email = req.body.email.toLowerCase();
    }
    next();
  },

  // Remove undefined and null values
  removeEmpty: (req, _res, next) => {
    const clean = (obj) => {
      for (const key in obj) {
        if (obj[key] === undefined || obj[key] === null || obj[key] === '') {
          delete obj[key];
        } else if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
          clean(obj[key]);
        }
      }
    };
    clean(req.body);
    next();
  },
};

// ── Custom Validators ──────────────────────────────

const customValidators = {
  // Password doesn't contain personal info
  noPersonalInfo: (value, { req }) => {
    const lowerPassword = value.toLowerCase();
    
    // Check against email
    if (req.body.email) {
      const emailLocal = req.body.email.split('@')[0].toLowerCase();
      if (emailLocal.length >= 4 && lowerPassword.includes(emailLocal)) {
        throw new Error('Password must not contain your email');
      }
    }
    
    // Check against name
    if (req.body.name) {
      const nameParts = req.body.name.toLowerCase().split(/\s+/);
      for (const part of nameParts) {
        if (part.length >= 3 && lowerPassword.includes(part)) {
          throw new Error('Password must not contain parts of your name');
        }
      }
    }
    
    return true;
  },

  // Future date validation
  isFutureDate: (value) => {
    const date = new Date(value);
    if (date <= new Date()) {
      throw new Error('Date must be in the future');
    }
    return true;
  },

  // Date within range
  isWithinDays: (days) => (value) => {
    const date = new Date(value);
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + days);
    
    if (date > maxDate) {
      throw new Error(`Date cannot be more than ${days} days from now`);
    }
    return true;
  },
};

module.exports = {
  ...commonValidators,
  ...passwordValidators,
  ...tokenValidators,
  ...roleValidators,
  sanitizers,
  customValidators,
};
