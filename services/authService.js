const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
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
    
    console.log('✅ Auth Service: MySQL connected');
  } catch (error) {
    console.error('❌ Auth Service: MySQL connection failed:', error.message);
    throw error;
  }
};

// JWT utilities (using your pattern)
const generateTokens = (userId, email, role = 'caregiver') => {
  const accessToken = jwt.sign(
    { userId, email, role }, 
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  
  const refreshToken = jwt.sign(
    { userId, email, role },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
  
  return { accessToken, refreshToken };
};

// Error handler middleware
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
    service: 'auth-service',
    timestamp: new Date()
  });
});

// Register endpoint (using your exact pattern)
app.post('/register', asyncHandler(async (req, res) => {
  const { name, email, password, phone, role = 'caregiver' } = req.body;
  
  if (!name || !email || !password) {
    throw new ValidationError('Name, email, and password are required');
  }

  if (password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters long');
  }
  
  // Check if user exists
  const [existingUsers] = await mysqlConnection.execute(
    'SELECT id FROM users WHERE email = ?',
    [email]
  );
  
  if (existingUsers.length > 0) {
    throw new ValidationError('User already exists with this email');
  }
  
  // Hash password
  const hashedPassword = await bcrypt.hash(password, 12);
  
  // Create user in MySQL
  const [result] = await mysqlConnection.execute(`
    INSERT INTO users (name, email, password_hash, phone, role, preferences, created_at)
    VALUES (?, ?, ?, ?, ?, '{}', NOW())
  `, [name, email, hashedPassword, phone || null, role]);
  
  const userId = result.insertId;
  
  // Generate tokens
  const tokens = generateTokens(userId, email, role);
  
  // Store refresh token
  await mysqlConnection.execute(`
    INSERT INTO refresh_tokens (user_id, token, expires_at, created_at)
    VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY), NOW())
  `, [userId, tokens.refreshToken]);
  
  // Get created user data
  const [userData] = await mysqlConnection.execute(`
    SELECT id, name, email, phone, role, preferences, created_at
    FROM users WHERE id = ?
  `, [userId]);
  
  res.status(201).json({
    message: 'User registered successfully',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: userData[0]
  });
}));

// Login endpoint (using your exact pattern)
app.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }
  
  // Find user
  const [users] = await mysqlConnection.execute(`
    SELECT id, name, email, password_hash, phone, role, preferences, 
           last_active, created_at
    FROM users WHERE email = ? AND deleted_at IS NULL
  `, [email]);
  
  if (users.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const user = users[0];
  
  // Check password
  const isValidPassword = await bcrypt.compare(password, user.password_hash);
  if (!isValidPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  // Update last active
  await mysqlConnection.execute(
    'UPDATE users SET last_active = NOW() WHERE id = ?',
    [user.id]
  );
  
  // Clean old refresh tokens
  await mysqlConnection.execute(
    'DELETE FROM refresh_tokens WHERE user_id = ? AND expires_at < NOW()',
    [user.id]
  );
  
  // Generate new tokens
  const tokens = generateTokens(user.id, user.email, user.role);
  
  // Store new refresh token
  await mysqlConnection.execute(`
    INSERT INTO refresh_tokens (user_id, token, expires_at, created_at)
    VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY), NOW())
  `, [user.id, tokens.refreshToken]);
  
  // Remove sensitive data
  delete user.password_hash;
  
  // Parse preferences JSON
  try {
    user.preferences = JSON.parse(user.preferences || '{}');
  } catch (e) {
    user.preferences = {};
  }
  
  res.json({
    message: 'Login successful',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: user
  });
}));

// Token refresh endpoint (using your exact pattern)
app.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }
  
  // Verify refresh token
  const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  
  // Check if refresh token exists in database and is valid
  const [tokens] = await mysqlConnection.execute(`
    SELECT rt.id, u.id as user_id, u.email, u.role
    FROM refresh_tokens rt
    JOIN users u ON rt.user_id = u.id
    WHERE rt.token = ? AND rt.expires_at > NOW() AND u.deleted_at IS NULL
  `, [refreshToken]);
  
  if (tokens.length === 0) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
  
  const tokenData = tokens[0];
  
  // Generate new tokens
  const newTokens = generateTokens(tokenData.user_id, tokenData.email, tokenData.role);
  
  // Update refresh token in database
  await mysqlConnection.execute(`
    UPDATE refresh_tokens 
    SET token = ?, expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY)
    WHERE id = ?
  `, [newTokens.refreshToken, tokenData.id]);
  
  res.json({
    accessToken: newTokens.accessToken,
    refreshToken: newTokens.refreshToken
  });
}));

// Token validation endpoint (using your exact pattern)
app.post('/validate', asyncHandler(async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(401).json({ valid: false, error: 'Token required' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Verify user still exists and is active
    const [users] = await mysqlConnection.execute(
      'SELECT id, email, role FROM users WHERE id = ? AND deleted_at IS NULL',
      [decoded.userId]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ valid: false, error: 'User not found' });
    }
    
    res.json({
      valid: true,
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role
    });
  } catch (error) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
  }
}));

// Logout endpoint (using your exact pattern)
app.post('/logout', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  
  if (refreshToken) {
    // Remove refresh token from database
    await mysqlConnection.execute(
      'DELETE FROM refresh_tokens WHERE token = ?',
      [refreshToken]
    );
  }
  
  res.json({ message: 'Logged out successfully' });
}));

// Error handler
app.use((error, req, res, next) => {
  console.error('Auth Service error:', error);
  
  if (error.name === 'ValidationError') {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }
  
  if (error.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  if (error.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Token expired' });
  }
  
  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(400).json({ error: 'Duplicate entry - this record already exists' });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize and start server
async function startServer() {
  try {
    await connectMySQL();
    
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
      console.log(`🔐 Auth Service running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start Auth Service:', error);
    process.exit(1);
  }
}

startServer();