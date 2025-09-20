const errorHandler = (error, req, res, next) => {
  console.error('Server error:', error);
  
  // Mongoose validation error
  if (error.name === 'ValidationError') {
    const errors = Object.values(error.errors).map(val => val.message);
    return res.status(400).json({ 
      error: 'Validation Error', 
      details: errors 
    });
  }
  
  // MySQL errors
  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(400).json({ 
      error: 'Duplicate entry - this record already exists' 
    });
  }

  if (error.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({ 
      error: 'Invalid reference - related record not found' 
    });
  }

  if (error.code === 'ER_ACCESS_DENIED_ERROR') {
    return res.status(500).json({ 
      error: 'Database access denied' 
    });
  }

  // MongoDB/Cosmos DB errors
  if (error.name === 'MongoError' || error.name === 'MongoServerError') {
    if (error.code === 11000) {
      return res.status(400).json({ 
        error: 'Duplicate field value entered' 
      });
    }
    return res.status(500).json({ 
      error: 'Database operation failed' 
    });
  }
  
  // JWT errors
  if (error.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  if (error.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Token expired' });
  }

  // Multer errors (file upload)
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ 
      error: 'File too large' 
    });
  }

  if (error.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ 
      error: 'Too many files' 
    });
  }

  // Axios errors (external API calls)
  if (error.response && error.response.status) {
    return res.status(500).json({ 
      error: 'External service error',
      statusCode: error.response.status 
    });
  }

  // Rate limit errors
  if (error.statusCode === 429) {
    return res.status(429).json({ 
      error: 'Too many requests, please try again later' 
    });
  }

  // Custom application errors
  if (error.statusCode && error.message) {
    return res.status(error.statusCode).json({ 
      error: error.message 
    });
  }
  
  // Default server error
  res.status(500).json({ 
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { 
      details: error.message,
      stack: error.stack 
    })
  });
};

// Custom error classes
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized access') {
    super(message, 401);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden access') {
    super(message, 403);
  }
}

// Async error wrapper
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

module.exports = {
  errorHandler,
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  asyncHandler
};