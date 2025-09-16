// middleware/errorHandler.js
import { validationResult } from 'express-validator';

// Environment check
const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

// Error types enum
const ERROR_TYPES = {
  VALIDATION_ERROR: 'ValidationError',
  MONGOOSE_ERROR: 'MongooseError',
  CAST_ERROR: 'CastError',
  DUPLICATE_KEY_ERROR: 'MongoServerError',
  JWT_ERROR: 'JsonWebTokenError',
  RATE_LIMIT_ERROR: 'RateLimitError',
  AUTHORIZATION_ERROR: 'AuthorizationError',
  NOT_FOUND_ERROR: 'NotFoundError',
  BUSINESS_LOGIC_ERROR: 'BusinessLogicError'
};

// HTTP status codes
const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503
};

// Custom error classes
export class AppError extends Error {
  constructor(message, statusCode, errorCode = null, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();

    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message, details = []) {
    super(message, HTTP_STATUS.BAD_REQUEST, 'VALIDATION_ERROR');
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden') {
    super(message, HTTP_STATUS.FORBIDDEN, 'FORBIDDEN');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, HTTP_STATUS.CONFLICT, 'CONFLICT');
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded') {
    super(message, HTTP_STATUS.TOO_MANY_REQUESTS, 'RATE_LIMIT_EXCEEDED');
  }
}

// Error response formatter
function formatErrorResponse(error, req) {
  const correlationId =
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    generateCorrelationId();

  const baseResponse = {
    success: false,
    error: {
      message: error.message,
      code: error.errorCode || error.name || 'UNKNOWN_ERROR',
      timestamp: error.timestamp || new Date().toISOString(),
      correlationId,
      path: req.path,
      method: req.method
    }
  };

  // Add details for validation errors
  if (error.details && Array.isArray(error.details)) {
    baseResponse.error.details = error.details;
  }

  // Add stack trace in development
  if (isDevelopment && error.stack) {
    baseResponse.error.stack = error.stack;
  }

  // Add error type for debugging
  if (isDevelopment) {
    baseResponse.error.type = error.constructor.name;
  }

  return baseResponse;
}

// MongoDB error handler
function handleMongoError(error) {
  let message = 'Database operation failed';
  let statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR;
  let errorCode = 'DATABASE_ERROR';

  switch (error.name) {
    case 'CastError':
      message = `Invalid ${error.path}: ${error.value}`;
      statusCode = HTTP_STATUS.BAD_REQUEST;
      errorCode = 'INVALID_ID';
      break;

    case 'ValidationError': {
      const errors = Object.values(error.errors).map((err) => ({
        field: err.path,
        message: err.message,
        value: err.value
      }));
      return new ValidationError('Validation failed', errors);
    }

    case 'MongoServerError':
      if (error.code === 11000) {
        // Duplicate key error
        const field = Object.keys(error.keyPattern)[0];
        const value = error.keyValue[field];
        message = `${field} '${value}' already exists`;
        statusCode = HTTP_STATUS.CONFLICT;
        errorCode = 'DUPLICATE_ENTRY';
      }
      break;

    case 'MongoNetworkError':
      message = 'Database connection failed';
      statusCode = HTTP_STATUS.SERVICE_UNAVAILABLE;
      errorCode = 'DATABASE_UNAVAILABLE';
      break;

    case 'MongoTimeoutError':
      message = 'Database operation timed out';
      statusCode = HTTP_STATUS.SERVICE_UNAVAILABLE;
      errorCode = 'DATABASE_TIMEOUT';
      break;
  }

  return new AppError(message, statusCode, errorCode);
}

// JWT error handler
function handleJWTError(error) {
  let message = 'Authentication failed';

  switch (error.name) {
    case 'JsonWebTokenError':
      message = 'Invalid authentication token';
      break;
    case 'TokenExpiredError':
      message = 'Authentication token has expired';
      break;
    case 'NotBeforeError':
      message = 'Authentication token not active yet';
      break;
  }

  return new UnauthorizedError(message);
}

// Rate limit error handler
function handleRateLimitError(error) {
  const resetTime = error.reset ? new Date(error.reset) : null;
  const retryAfter = error.retryAfter || 'unknown';

  let message = 'Too many requests. Please try again later.';

  if (resetTime) {
    message += ` Try again after ${resetTime.toISOString()}.`;
  }

  const rateLimitError = new RateLimitError(message);
  rateLimitError.retryAfter = retryAfter;
  rateLimitError.resetTime = resetTime;

  return rateLimitError;
}

// Express-validator error handler
function handleValidationErrors(errors) {
  const details = errors.map((error) => ({
    field: error.path || error.param,
    message: error.msg,
    value: error.value,
    location: error.location
  }));

  return new ValidationError('Request validation failed', details);
}

// Log error for monitoring
function logError(error, req, res) {
  const logData = {
    timestamp: new Date().toISOString(),
    level: 'error',
    message: error.message,
    stack: error.stack,
    statusCode: res.statusCode,
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    userId: req.user?.id || req.user?.userId,
    correlationId: req.headers['x-correlation-id'],
    requestId: req.headers['x-request-id'],
    errorCode: error.errorCode || error.name,
    isOperational: error.isOperational || false
  };

  // Log critical errors differently
  if (res.statusCode >= 500 || !error.isOperational) {
    console.error('Critical Error:', JSON.stringify(logData, null, 2));
  } else {
    console.warn('Operational Error:', JSON.stringify(logData, null, 2));
  }
}

// Generate correlation ID
function generateCorrelationId() {
  return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Main error handler middleware
export function errorHandler(err, req, res, next) {
  let error = err;

  // Handle different error types
  if (err.name && err.name.includes('Mongo')) {
    error = handleMongoError(err);
  } else if (err.name && err.name.includes('JsonWebToken')) {
    error = handleJWTError(err);
  } else if (err.name === 'ValidationError' && err.errors) {
    error = handleValidationErrors(err.errors);
  } else if (err.type === 'entity.parse.failed') {
    error = new ValidationError('Invalid JSON payload');
  } else if (err.type === 'entity.too.large') {
    error = new ValidationError('Request payload too large');
  } else if (err.code === 'LIMIT_FILE_SIZE') {
    error = new ValidationError('File size too large');
  } else if (err.code === 'ECONNREFUSED') {
    error = new AppError(
      'Service temporarily unavailable',
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      'SERVICE_UNAVAILABLE'
    );
  } else if (err.code === 'ETIMEDOUT') {
    error = new AppError(
      'Request timeout',
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      'TIMEOUT'
    );
  } else if (err.statusCode === 429) {
    error = handleRateLimitError(err);
  }

  // Ensure error has required properties
  if (!error.statusCode) {
    error = new AppError(
      error.message || 'Internal server error',
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      'INTERNAL_ERROR',
      false
    );
  }

  // Set response status
  res.status(error.statusCode);

  // Log error
  logError(error, req, res);

  // Send error response
  const errorResponse = formatErrorResponse(error, req);

  // Add rate limit headers if applicable
  if (error instanceof RateLimitError) {
    if (error.retryAfter) {
      res.set('Retry-After', error.retryAfter);
    }
    if (error.resetTime) {
      res.set('X-RateLimit-Reset', Math.ceil(error.resetTime.getTime() / 1000));
    }
  }

  // Set security headers
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block'
  });

  res.json(errorResponse);
}

// 404 handler for unmatched routes
export function notFoundHandler(req, res, next) {
  const error = new NotFoundError(`Route ${req.originalUrl} not found`);
  next(error);
}

// Async error handler wrapper
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError
};
