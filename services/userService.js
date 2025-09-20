const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// MySQL connection (using your existing pattern)
let mysqlConnection = null;

const connectMySQL = async () => {
  try {
    mysqlConnection = mysql.createPool({
      host: process.env.AZURE_MYSQL_HOST,
      user: process.env.AZURE_MYSQL_USER,
      password: process.env.AZURE_MYSQL_PASSWORD,
      database: process.env.AZURE_MYSQL_DATABASE,
      port: process.env.AZURE_MYSQL_PORT || 3306,
      ssl: { rejectUnauthorized: false },
      connectionLimit: 10,
      acquireTimeout: 60000,
      timeout: 60000,
      reconnect: true,
      charset: 'utf8mb4'
    });
    
    // Test connection
    const connection = await mysqlConnection.getConnection();
    await connection.ping();
    connection.release();
    
    console.log('✅ User Service: MySQL connected');
  } catch (error) {
    console.error('❌ User Service: MySQL connection failed:', error.message);
    throw error;
  }
};

// Authentication middleware (using your exact pattern)
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    // Validate token with auth service
    const authResponse = await axios.post(`${process.env.AUTH_SERVICE_URL || 'http://localhost:3001'}/validate`, {
      token
    });
    
    if (!authResponse.data.valid) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Verify user still exists and is active
    const [users] = await mysqlConnection.execute(
      'SELECT id, email, role, name FROM users WHERE id = ? AND deleted_at IS NULL',
      [authResponse.data.userId]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid token - user not found' });
    }
    
    req.user = {
      userId: authResponse.data.userId,
      email: authResponse.data.email,
      role: authResponse.data.role,
      name: users[0].name
    };
    
    next();
  } catch (error) {
    console.error('Token validation error:', error.message);
    return res.status(403).json({ error: 'Token verification failed' });
  }
};

// Error handling utilities
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'user-service',
    timestamp: new Date()
  });
});

// Get current user info (using your exact pattern)
app.get('/me', authenticateToken, asyncHandler(async (req, res) => {
  const [users] = await mysqlConnection.execute(`
    SELECT id, name, email, phone, role, preferences, last_active, created_at
    FROM users WHERE id = ? AND deleted_at IS NULL
  `, [req.user.userId]);
  
  if (users.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const user = users[0];
  try {
    user.preferences = JSON.parse(user.preferences || '{}');
  } catch (e) {
    user.preferences = {};
  }
  
  res.json(user);
}));

// Update user profile
app.put('/profile', authenticateToken, asyncHandler(async (req, res) => {
  const { name, phone, preferences } = req.body;
  
  if (!name || name.trim().length === 0) {
    throw new ValidationError('Name is required');
  }
  
  // Validate preferences if provided
  let preferencesJson = '{}';
  if (preferences) {
    try {
      preferencesJson = JSON.stringify(preferences);
    } catch (error) {
      throw new ValidationError('Invalid preferences format');
    }
  }
  
  // Update user
  await mysqlConnection.execute(`
    UPDATE users 
    SET name = ?, phone = ?, preferences = ?, updated_at = NOW()
    WHERE id = ? AND deleted_at IS NULL
  `, [name.trim(), phone || null, preferencesJson, req.user.userId]);
  
  // Get updated user data
  const [users] = await mysqlConnection.execute(`
    SELECT id, name, email, phone, role, preferences, last_active, created_at, updated_at
    FROM users WHERE id = ?
  `, [req.user.userId]);
  
  const user = users[0];
  try {
    user.preferences = JSON.parse(user.preferences || '{}');
  } catch (e) {
    user.preferences = {};
  }
  
  res.json({
    message: 'Profile updated successfully',
    user: user
  });
}));

// Get user by ID (for other services or admin use)
app.get('/:userId', authenticateToken, asyncHandler(async (req, res) => {
  const { userId } = req.params;
  
  // Check if user can access this profile (themselves or admin)
  if (req.user.userId !== parseInt(userId) && !['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  
  const [users] = await mysqlConnection.execute(`
    SELECT id, name, email, phone, role, preferences, last_active, created_at
    FROM users WHERE id = ? AND deleted_at IS NULL
  `, [userId]);
  
  if (users.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const user = users[0];
  try {
    user.preferences = JSON.parse(user.preferences || '{}');
  } catch (e) {
    user.preferences = {};
  }
  
  res.json(user);
}));

// Get all users (admin only)
app.get('/', authenticateToken, asyncHandler(async (req, res) => {
  // Check admin permissions
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const { page = 1, limit = 20, role, search } = req.query;
  const offset = (page - 1) * limit;
  
  let query = `
    SELECT id, name, email, phone, role, last_active, created_at
    FROM users WHERE deleted_at IS NULL
  `;
  const params = [];
  
  // Add role filter
  if (role) {
    query += ' AND role = ?';
    params.push(role);
  }
  
  // Add search filter
  if (search) {
    query += ' AND (name LIKE ? OR email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  // Add pagination
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  
  const [users] = await mysqlConnection.execute(query, params);
  
  // Get total count
  let countQuery = 'SELECT COUNT(*) as total FROM users WHERE deleted_at IS NULL';
  const countParams = [];
  
  if (role) {
    countQuery += ' AND role = ?';
    countParams.push(role);
  }
  
  if (search) {
    countQuery += ' AND (name LIKE ? OR email LIKE ?)';
    countParams.push(`%${search}%`, `%${search}%`);
  }
  
  const [countResult] = await mysqlConnection.execute(countQuery, countParams);
  const total = countResult[0].total;
  
  res.json({
    users,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  });
}));

// Update user role (admin only)
app.put('/:userId/role', authenticateToken, asyncHandler(async (req, res) => {
  // Check admin permissions
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const { userId } = req.params;
  const { role } = req.body;
  
  const validRoles = ['caregiver', 'counselor', 'therapist', 'admin', 'super_admin'];
  if (!role || !validRoles.includes(role)) {
    throw new ValidationError('Invalid role specified');
  }
  
  // Prevent self-demotion from super_admin
  if (req.user.userId === parseInt(userId) && req.user.role === 'super_admin' && role !== 'super_admin') {
    return res.status(400).json({ error: 'Cannot demote yourself from super admin' });
  }
  
  // Update user role
  const [result] = await mysqlConnection.execute(`
    UPDATE users 
    SET role = ?, updated_at = NOW()
    WHERE id = ? AND deleted_at IS NULL
  `, [role, userId]);
  
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({
    message: 'User role updated successfully',
    userId: parseInt(userId),
    newRole: role
  });
}));

// Deactivate user (admin only)
app.put('/:userId/deactivate', authenticateToken, asyncHandler(async (req, res) => {
  // Check admin permissions
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const { userId } = req.params;
  
  // Prevent self-deactivation
  if (req.user.userId === parseInt(userId)) {
    return res.status(400).json({ error: 'Cannot deactivate yourself' });
  }
  
  // Soft delete user
  const [result] = await mysqlConnection.execute(`
    UPDATE users 
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = ? AND deleted_at IS NULL
  `, [userId]);
  
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Revoke all refresh tokens
  await mysqlConnection.execute(
    'DELETE FROM refresh_tokens WHERE user_id = ?',
    [userId]
  );
  
  res.json({
    message: 'User deactivated successfully',
    userId: parseInt(userId)
  });
}));

// Reactivate user (admin only)
app.put('/:userId/reactivate', authenticateToken, asyncHandler(async (req, res) => {
  // Check admin permissions
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const { userId } = req.params;
  
  // Reactivate user
  const [result] = await mysqlConnection.execute(`
    UPDATE users 
    SET deleted_at = NULL, updated_at = NOW()
    WHERE id = ? AND deleted_at IS NOT NULL
  `, [userId]);
  
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'User not found or already active' });
  }
  
  res.json({
    message: 'User reactivated successfully',
    userId: parseInt(userId)
  });
}));

// Get user statistics (admin only)
app.get('/stats/overview', authenticateToken, asyncHandler(async (req, res) => {
  // Check admin permissions
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  // Get user counts by role
  const [roleCounts] = await mysqlConnection.execute(`
    SELECT role, COUNT(*) as count
    FROM users 
    WHERE deleted_at IS NULL
    GROUP BY role
  `);
  
  // Get total users
  const [totalResult] = await mysqlConnection.execute(`
    SELECT COUNT(*) as total FROM users WHERE deleted_at IS NULL
  `);
  
  // Get new users this month
  const [newUsersResult] = await mysqlConnection.execute(`
    SELECT COUNT(*) as newThisMonth 
    FROM users 
    WHERE deleted_at IS NULL 
    AND created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)
  `);
  
  // Get active users (logged in within last 7 days)
  const [activeUsersResult] = await mysqlConnection.execute(`
    SELECT COUNT(*) as activeUsers
    FROM users 
    WHERE deleted_at IS NULL 
    AND last_active >= DATE_SUB(NOW(), INTERVAL 7 DAY)
  `);
  
  res.json({
    totalUsers: totalResult[0].total,
    newUsersThisMonth: newUsersResult[0].newThisMonth,
    activeUsers: activeUsersResult[0].activeUsers,
    usersByRole: roleCounts.reduce((acc, curr) => {
      acc[curr.role] = curr.count;
      return acc;
    }, {}),
    timestamp: new Date()
  });
}));

// Error handler
app.use((error, req, res, next) => {
  console.error('User Service error:', error);
  
  if (error.name === 'ValidationError') {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }
  
  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(400).json({ error: 'Duplicate entry - this record already exists' });
  }
  
  if (error.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({ error: 'Invalid reference - related record not found' });
  }
  
  if (error.response && error.response.status) {
    return res.status(error.response.status).json({ 
      error: 'External service error',
      details: error.response.data?.error || 'Service unavailable'
    });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize and start server
async function startServer() {
  try {
    await connectMySQL();
    
    const PORT = process.env.PORT || 3002;
    app.listen(PORT, () => {
      console.log(`👤 User Service running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start User Service:', error);
    process.exit(1);
  }
}

startServer();