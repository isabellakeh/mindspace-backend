const jwt = require('jsonwebtoken');
const { mysqlConnection } = require('../config/mysql');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Verify user still exists and is active
    const users = await mysqlConnection.execute(
      'SELECT id, email, role, name FROM users WHERE id = ? AND deleted_at IS NULL',
      [decoded.userId]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid token - user not found' });
    }
    
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      name: users[0].name
    };
    
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(403).json({ error: 'Token verification failed' });
  }
};

// Optional authentication - doesn't fail if no token provided
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const users = await mysqlConnection.execute(
      'SELECT id, email, role, name FROM users WHERE id = ? AND deleted_at IS NULL',
      [decoded.userId]
    );
    
    if (users.length > 0) {
      req.user = {
        userId: decoded.userId,
        email: decoded.email,
        role: decoded.role,
        name: users[0].name
      };
    } else {
      req.user = null;
    }
  } catch (error) {
    req.user = null;
  }

  next();
};

// Role-based authorization middleware
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRoles = Array.isArray(roles) ? roles : [roles];
    
    if (!userRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
};

// Admin only middleware
const requireAdmin = requireRole(['admin', 'super_admin']);

// Professional or admin middleware
const requireProfessional = requireRole(['admin', 'super_admin', 'counselor', 'therapist']);

module.exports = {
  authenticateToken,
  optionalAuth,
  requireRole,
  requireAdmin,
  requireProfessional
};