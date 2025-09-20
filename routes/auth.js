const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { mysqlConnection } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler, ValidationError } = require('../middleware/errorHandler');

const router = express.Router();

// JWT utilities
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

// Register endpoint
router.post('/register', asyncHandler(async (req, res) => {
  const { name, email, password, phone, role = 'caregiver' } = req.body;
  
  if (!name || !email || !password) {
    throw new ValidationError('Name, email, and password are required');
  }

  if (password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters long');
  }
  
  // Check if user exists
  const existingUsers = await mysqlConnection.execute(
    'SELECT id FROM users WHERE email = ?',
    [email]
  );
  
  if (existingUsers.length > 0) {
    throw new ValidationError('User already exists with this email');
  }
  
  // Hash password
  const hashedPassword = await bcrypt.hash(password, 12);
  
  // Create user in MySQL
  const result = await mysqlConnection.execute(`
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
  const userData = await mysqlConnection.execute(`
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

// Login endpoint
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }
  
  // Find user
  const users = await mysqlConnection.execute(`
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

// Token refresh endpoint
router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }
  
  // Verify refresh token
  const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  
  // Check if refresh token exists in database and is valid
  const tokens = await mysqlConnection.execute(`
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

// Token validation endpoint (for other services)
router.post('/validate', asyncHandler(async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(401).json({ valid: false, error: 'Token required' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Verify user still exists and is active
    const users = await mysqlConnection.execute(
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

// Logout endpoint
router.post('/logout', asyncHandler(async (req, res) => {
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

// Change password endpoint
router.post('/change-password', authenticateToken, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    throw new ValidationError('Current password and new password are required');
  }

  if (newPassword.length < 8) {
    throw new ValidationError('New password must be at least 8 characters long');
  }
  
  // Get user's current password
  const users = await mysqlConnection.execute(
    'SELECT password_hash FROM users WHERE id = ?',
    [req.user.userId]
  );
  
  if (users.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Verify current password
  const isValidPassword = await bcrypt.compare(currentPassword, users[0].password_hash);
  if (!isValidPassword) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  
  // Hash new password
  const hashedNewPassword = await bcrypt.hash(newPassword, 12);
  
  // Update password
  await mysqlConnection.execute(
    'UPDATE users SET password_hash = ? WHERE id = ?',
    [hashedNewPassword, req.user.userId]
  );
  
  // Invalidate all refresh tokens for this user
  await mysqlConnection.execute(
    'DELETE FROM refresh_tokens WHERE user_id = ?',
    [req.user.userId]
  );
  
  res.json({ message: 'Password changed successfully' });
}));

// Forgot password endpoint (basic implementation)
router.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    throw new ValidationError('Email is required');
  }
  
  // Check if user exists
  const users = await mysqlConnection.execute(
    'SELECT id FROM users WHERE email = ? AND deleted_at IS NULL',
    [email]
  );
  
  // Always return success for security (don't reveal if email exists)
  res.json({ 
    message: 'If an account with this email exists, you will receive password reset instructions.' 
  });
  
  if (users.length > 0) {
    // TODO: Implement email sending with reset token
    // For now, just log that a reset was requested
    console.log(`Password reset requested for user ID: ${users[0].id}, email: ${email}`);
  }
}));

// Get current user info
router.get('/me', authenticateToken, asyncHandler(async (req, res) => {
  const users = await mysqlConnection.execute(`
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

module.exports = router;