/**
 * Centralized Error Handling Middleware
 * Provides consistent error responses and logging
 */

/**
 * Custom Error Classes
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message, details = []) {
    super(message, 400);
    this.details = details;
    this.type = 'VALIDATION_ERROR';
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401);
    this.type = 'AUTHENTICATION_ERROR';
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403);
    this.type = 'AUTHORIZATION_ERROR';
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404);
    this.type = 'NOT_FOUND_ERROR';
  }
}

export class DatabaseError extends AppError {
  constructor(message = 'Database operation failed', originalError = null) {
    super(message, 500);
    this.type = 'DATABASE_ERROR';
    this.originalError = originalError;
  }
}

export class FileProcessingError extends AppError {
  constructor(message = 'File processing failed', fileName = '') {
    super(message, 422);
    this.type = 'FILE_PROCESSING_ERROR';
    this.fileName = fileName;
  }
}

/**
 * Error Logger
 */
const logError = (error, req = null) => {
  const timestamp = new Date().toISOString();
  const logLevel = error.statusCode >= 500 ? 'ERROR' : 'WARN';

  console.error(`[${timestamp}] [${logLevel}] ${error.message}`);

  if (req) {
    console.error(`  Request: ${req.method} ${req.path}`);
    console.error(`  User: ${req.user?.id || 'unauthenticated'}`);
    console.error(`  IP: ${req.ip}`);
  }

  if (error.stack && error.statusCode >= 500) {
    console.error(`  Stack: ${error.stack}`);
  }

  if (error.originalError) {
    console.error(`  Original Error: ${error.originalError.message}`);
  }
};

/**
 * Main Error Handler Middleware
 */
export const errorHandler = (err, req, res, next) => {
  // Default to 500 server error
  let error = err;

  // If it's not already an AppError, convert it
  if (!(error instanceof AppError)) {
    // MySQL errors
    if (error.code === 'ER_DUP_ENTRY') {
      error = new ValidationError('Duplicate entry. This record already exists.', [error.sqlMessage]);
    } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      error = new ValidationError('Referenced record does not exist.', [error.sqlMessage]);
    } else if (error.code === 'ECONNREFUSED') {
      error = new DatabaseError('Database connection refused. Please try again later.', err);
    } else if (error.code === 'ETIMEDOUT') {
      error = new DatabaseError('Database operation timed out. Please try again.', err);
    }
    // JWT errors
    else if (error.name === 'JsonWebTokenError') {
      error = new AuthenticationError('Invalid authentication token');
    } else if (error.name === 'TokenExpiredError') {
      error = new AuthenticationError('Authentication token has expired');
    }
    // Multer errors
    else if (error.name === 'MulterError') {
      if (error.code === 'LIMIT_FILE_SIZE') {
        error = new ValidationError('File size exceeds limit', ['Maximum file size is 50MB']);
      } else if (error.code === 'LIMIT_FILE_COUNT') {
        error = new ValidationError('Too many files', ['Maximum 10 files per upload']);
      } else {
        error = new ValidationError('File upload failed', [error.message]);
      }
    }
    // Validation errors from validators
    else if (error.name === 'ValidationError') {
      error = new ValidationError(error.message, error.details || []);
    }
    // Generic errors
    else {
      error = new AppError(
        process.env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : error.message,
        error.statusCode || 500,
        false
      );
    }
  }

  // Log the error
  logError(error, req);

  // Send error response
  const response = {
    error: error.message,
    type: error.type || 'INTERNAL_SERVER_ERROR',
    timestamp: error.timestamp || new Date().toISOString()
  };

  // Add details for validation errors
  if (error.details) {
    response.details = error.details;
  }

  // Add fileName for file processing errors
  if (error.fileName) {
    response.fileName = error.fileName;
  }

  // Include stack trace in development
  if (process.env.NODE_ENV === 'development' && error.stack) {
    response.stack = error.stack;
  }

  // Add request ID if available
  if (req.id) {
    response.requestId = req.id;
  }

  res.status(error.statusCode || 500).json(response);
};

/**
 * 404 Not Found Handler
 */
export const notFoundHandler = (req, res, next) => {
  const error = new NotFoundError(`Route ${req.method} ${req.path}`);
  next(error);
};

/**
 * Async Handler Wrapper
 * Wraps async route handlers to catch errors automatically
 */
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Timeout Handler
 * Prevents requests from hanging indefinitely
 */
export const timeoutHandler = (timeoutMs = 30000) => {
  return (req, res, next) => {
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        const error = new AppError('Request timeout', 408);
        next(error);
      }
    }, timeoutMs);

    res.on('finish', () => clearTimeout(timeout));
    res.on('close', () => clearTimeout(timeout));

    next();
  };
};

/**
 * Request Logger Middleware
 */
export const requestLogger = (req, res, next) => {
  const start = Date.now();

  // Generate unique request ID
  req.id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Log request
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Request ID: ${req.id}`);

  // Log response
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logLevel = res.statusCode >= 400 ? 'WARN' : 'INFO';
    console.log(
      `[${new Date().toISOString()}] [${logLevel}] ${req.method} ${req.path} ` +
      `${res.statusCode} - ${duration}ms - Request ID: ${req.id}`
    );
  });

  next();
};

/**
 * Security Headers Middleware (Enhanced)
 */
export const securityHeaders = (req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Enable XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Content Security Policy (CSP)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;"
    );
  }

  // HSTS (Strict Transport Security) - Only in production with HTTPS
  if (process.env.NODE_ENV === 'production' && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  next();
};

/**
 * Rate Limiter Error Handler
 */
export const rateLimitErrorHandler = (req, res) => {
  res.status(429).json({
    error: 'Too many requests',
    type: 'RATE_LIMIT_EXCEEDED',
    message: 'You have exceeded the rate limit. Please try again later.',
    retryAfter: req.rateLimit?.resetTime || 'Unknown',
    timestamp: new Date().toISOString()
  });
};

export default {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  timeoutHandler,
  requestLogger,
  securityHeaders,
  rateLimitErrorHandler,
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  DatabaseError,
  FileProcessingError
};
