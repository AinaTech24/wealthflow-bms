/**
 * Input Validation Middleware
 * Validates and sanitizes user inputs to prevent injection attacks and data corruption
 */

/**
 * Sanitize string input - removes potential XSS and SQL injection patterns
 */
export const sanitizeString = (str) => {
  if (typeof str !== 'string') return str;
  return str
    .trim()
    .replace(/[<>]/g, '') // Remove HTML tags
    .replace(/['";\\]/g, '') // Remove SQL injection chars
    .substring(0, 500); // Limit length
};

/**
 * Validate email format
 */
export const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Validate PAN number (Indian Permanent Account Number)
 */
export const isValidPAN = (pan) => {
  const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
  return panRegex.test(pan);
};

/**
 * Validate UUID format
 */
export const isValidUUID = (uuid) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

/**
 * Validate table name (whitelist check)
 */
const VALID_TABLES = [
  'clients', 'team', 'transactions', 'batches', 'amc_mappings',
  'scheme_mappings', 'config', 'invoices', 'activity_log',
  'payout_ledger', 'brokerage_masters'
];

export const isValidTable = (tableName) => {
  return VALID_TABLES.includes(tableName);
};

/**
 * Middleware: Validate query parameters
 */
export const validateQueryParams = (schema) => {
  return (req, res, next) => {
    const errors = [];

    for (const [key, rules] of Object.entries(schema)) {
      const value = req.query[key];

      // Check if required
      if (rules.required && !value) {
        errors.push(`Missing required parameter: ${key}`);
        continue;
      }

      // Skip validation if optional and not provided
      if (!value && !rules.required) continue;

      // Type validation
      if (rules.type === 'string' && typeof value !== 'string') {
        errors.push(`Parameter ${key} must be a string`);
      }

      if (rules.type === 'number' && isNaN(Number(value))) {
        errors.push(`Parameter ${key} must be a number`);
      }

      if (rules.type === 'email' && !isValidEmail(value)) {
        errors.push(`Parameter ${key} must be a valid email`);
      }

      if (rules.type === 'table' && !isValidTable(value)) {
        errors.push(`Invalid table name: ${key}`);
      }

      // Pattern validation
      if (rules.pattern && !rules.pattern.test(value)) {
        errors.push(`Parameter ${key} has invalid format`);
      }

      // Enum validation
      if (rules.enum && !rules.enum.includes(value)) {
        errors.push(`Parameter ${key} must be one of: ${rules.enum.join(', ')}`);
      }

      // Min/Max validation
      if (rules.min && value.length < rules.min) {
        errors.push(`Parameter ${key} must be at least ${rules.min} characters`);
      }

      if (rules.max && value.length > rules.max) {
        errors.push(`Parameter ${key} must be at most ${rules.max} characters`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
    }

    next();
  };
};

/**
 * Middleware: Validate request body
 */
export const validateBody = (schema) => {
  return (req, res, next) => {
    const errors = [];

    for (const [key, rules] of Object.entries(schema)) {
      const value = req.body[key];

      // Check if required
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`Missing required field: ${key}`);
        continue;
      }

      // Skip validation if optional and not provided
      if ((value === undefined || value === null || value === '') && !rules.required) continue;

      // Type validation
      if (rules.type === 'string' && typeof value !== 'string') {
        errors.push(`Field ${key} must be a string`);
      }

      if (rules.type === 'number' && typeof value !== 'number') {
        errors.push(`Field ${key} must be a number`);
      }

      if (rules.type === 'boolean' && typeof value !== 'boolean') {
        errors.push(`Field ${key} must be a boolean`);
      }

      if (rules.type === 'array' && !Array.isArray(value)) {
        errors.push(`Field ${key} must be an array`);
      }

      if (rules.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
        errors.push(`Field ${key} must be an object`);
      }

      if (rules.type === 'email' && !isValidEmail(value)) {
        errors.push(`Field ${key} must be a valid email`);
      }

      if (rules.type === 'pan' && !isValidPAN(value)) {
        errors.push(`Field ${key} must be a valid PAN (format: AAAAA9999A)`);
      }

      // Enum validation
      if (rules.enum && !rules.enum.includes(value)) {
        errors.push(`Field ${key} must be one of: ${rules.enum.join(', ')}`);
      }

      // Min/Max validation for strings
      if (rules.type === 'string') {
        if (rules.min && value.length < rules.min) {
          errors.push(`Field ${key} must be at least ${rules.min} characters`);
        }
        if (rules.max && value.length > rules.max) {
          errors.push(`Field ${key} must be at most ${rules.max} characters`);
        }
      }

      // Min/Max validation for numbers
      if (rules.type === 'number') {
        if (rules.min !== undefined && value < rules.min) {
          errors.push(`Field ${key} must be at least ${rules.min}`);
        }
        if (rules.max !== undefined && value > rules.max) {
          errors.push(`Field ${key} must be at most ${rules.max}`);
        }
      }

      // Array validation
      if (rules.type === 'array') {
        if (rules.minLength && value.length < rules.minLength) {
          errors.push(`Field ${key} must contain at least ${rules.minLength} items`);
        }
        if (rules.maxLength && value.length > rules.maxLength) {
          errors.push(`Field ${key} must contain at most ${rules.maxLength} items`);
        }
      }

      // Custom validation
      if (rules.validate && typeof rules.validate === 'function') {
        const customError = rules.validate(value);
        if (customError) {
          errors.push(customError);
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
    }

    // Sanitize string inputs
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = sanitizeString(req.body[key]);
      }
    }

    next();
  };
};

/**
 * Validation schema for login
 */
export const loginValidation = validateBody({
  identifier: {
    type: 'string',
    required: true,
    min: 3,
    max: 100
  },
  password: {
    type: 'string',
    required: true,
    min: 3,
    max: 100
  }
});

/**
 * Validation schema for client creation
 */
export const clientValidation = validateBody({
  pan: {
    type: 'pan',
    required: true
  },
  name: {
    type: 'string',
    required: true,
    min: 2,
    max: 200
  },
  email: {
    type: 'email',
    required: false
  }
});

/**
 * Validation schema for team member creation
 */
export const teamValidation = validateBody({
  name: {
    type: 'string',
    required: true,
    min: 2,
    max: 100
  },
  code: {
    type: 'string',
    required: true,
    min: 3,
    max: 50
  },
  role: {
    type: 'string',
    required: true,
    enum: ['ADMIN', 'FINANCE', 'OPS', 'VIEWER']
  },
  level: {
    type: 'number',
    required: true,
    min: 0,
    max: 6
  },
  email: {
    type: 'email',
    required: false
  }
});

/**
 * File upload validation
 */
export const validateFileUpload = (options = {}) => {
  const {
    maxSize = 50 * 1024 * 1024, // 50MB default
    allowedTypes = ['application/pdf', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  } = options;

  return (req, res, next) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const errors = [];

    for (const file of req.files) {
      // Check file size
      if (file.size > maxSize) {
        errors.push(`File ${file.originalname} exceeds maximum size of ${maxSize / 1024 / 1024}MB`);
      }

      // Check file type
      if (!allowedTypes.includes(file.mimetype)) {
        errors.push(`File ${file.originalname} has invalid type. Allowed types: ${allowedTypes.join(', ')}`);
      }

      // Check for potential malicious extensions
      const dangerousExtensions = ['.exe', '.bat', '.sh', '.cmd', '.com', '.scr', '.js', '.vbs'];
      if (dangerousExtensions.some(ext => file.originalname.toLowerCase().endsWith(ext))) {
        errors.push(`File ${file.originalname} has potentially dangerous extension`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'File validation failed',
        details: errors
      });
    }

    next();
  };
};

export default {
  validateQueryParams,
  validateBody,
  validateFileUpload,
  loginValidation,
  clientValidation,
  teamValidation,
  sanitizeString,
  isValidEmail,
  isValidPAN,
  isValidTable
};
