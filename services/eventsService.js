const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Database connections
let mysqlConnection = null;

// Connect to MySQL (for events and appointments)
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
    
    const connection = await mysqlConnection.getConnection();
    await connection.ping();
    connection.release();
    
    console.log('✅ Events Service: MySQL connected');
  } catch (error) {
    console.error('❌ Events Service: MySQL connection failed:', error.message);
    throw error;
  }
};

// Authentication middleware
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
    
    req.user = {
      userId: authResponse.data.userId,
      email: authResponse.data.email,
      role: authResponse.data.role
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

// Utility functions
const parseDateTime = (dateTimeString) => {
  const dateTime = new Date(dateTimeString);
  if (isNaN(dateTime.getTime())) {
    throw new ValidationError('Invalid date/time format');
  }
  return dateTime;
};

const validateEventType = (eventType) => {
  const validTypes = [
    'appointment', 'therapy', 'medication', 'social', 'support_group', 
    'respite', 'educational', 'recreational', 'medical', 'other'
  ];
  
  if (!validTypes.includes(eventType)) {
    throw new ValidationError('Invalid event type');
  }
  
  return eventType;
};

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'events-service',
    timestamp: new Date()
  });
});

// ===============================
// EVENTS ENDPOINTS
// ===============================

// Create a new event
app.post('/events', authenticateToken, asyncHandler(async (req, res) => {
  const { 
    title, description, event_type, start_time, end_time, 
    location, is_recurring, recurrence_pattern, reminder_minutes,
    child_id, notes 
  } = req.body;
  
  if (!title || !event_type || !start_time) {
    throw new ValidationError('Title, event type, and start time are required');
  }
  
  const validatedEventType = validateEventType(event_type);
  const startTime = parseDateTime(start_time);
  const endTime = end_time ? parseDateTime(end_time) : null;
  
  // Validate end time if provided
  if (endTime && endTime <= startTime) {
    throw new ValidationError('End time must be after start time');
  }
  
  // Validate reminder minutes
  const reminderMins = reminder_minutes ? parseInt(reminder_minutes) : 15;
  if (isNaN(reminderMins) || reminderMins < 0) {
    throw new ValidationError('Reminder minutes must be a positive number');
  }
  
  const [result] = await mysqlConnection.execute(`
    INSERT INTO events (
      user_id, title, description, event_type, start_time, end_time,
      location, is_recurring, recurrence_pattern, reminder_minutes,
      child_id, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
  `, [
    req.user.userId, title.trim(), description || null, validatedEventType,
    startTime, endTime, location || null, !!is_recurring, recurrence_pattern || null,
    reminderMins, child_id || null, notes || null
  ]);
  
  const eventId = result.insertId;
  
  res.status(201).json({
    message: 'Event created successfully',
    eventId: eventId,
    startTime: startTime
  });
}));

// Get events for a user
app.get('/events', authenticateToken, asyncHandler(async (req, res) => {
  const { 
    start_date, end_date, event_type, child_id, 
    include_past = 'false', limit = 50 
  } = req.query;
  
  let query = `
    SELECT e.*, u.name as user_name, c.name as child_name
    FROM events e
    LEFT JOIN users u ON e.user_id = u.id
    LEFT JOIN children c ON e.child_id = c.id
    WHERE e.user_id = ? AND e.deleted_at IS NULL
  `;
  const params = [req.user.userId];
  
  // Date filtering
  if (start_date) {
    query += ' AND e.start_time >= ?';
    params.push(parseDateTime(start_date));
  }
  
  if (end_date) {
    query += ' AND e.start_time <= ?';
    params.push(parseDateTime(end_date));
  }
  
  // Don't include past events unless requested
  if (include_past === 'false') {
    query += ' AND e.start_time >= NOW()';
  }
  
  // Event type filter
  if (event_type) {
    query += ' AND e.event_type = ?';
    params.push(event_type);
  }
  
  // Child filter
  if (child_id) {
    query += ' AND e.child_id = ?';
    params.push(parseInt(child_id));
  }
  
  query += ' ORDER BY e.start_time ASC LIMIT ?';
  params.push(parseInt(limit));
  
  const [events] = await mysqlConnection.execute(query, params);
  
  res.json({
    events: events,
    count: events.length
  });
}));

// Get a specific event
app.get('/events/:eventId', authenticateToken, asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  
  const [events] = await mysqlConnection.execute(`
    SELECT e.*, u.name as user_name, c.name as child_name
    FROM events e
    LEFT JOIN users u ON e.user_id = u.id
    LEFT JOIN children c ON e.child_id = c.id
    WHERE e.id = ? AND e.user_id = ? AND e.deleted_at IS NULL
  `, [eventId, req.user.userId]);
  
  if (events.length === 0) {
    return res.status(404).json({ error: 'Event not found' });
  }
  
  res.json({ event: events[0] });
}));

// Update an event
app.put('/events/:eventId', authenticateToken, asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { 
    title, description, event_type, start_time, end_time, 
    location, is_recurring, recurrence_pattern, reminder_minutes,
    child_id, notes 
  } = req.body;
  
  // Check if event exists and belongs to user
  const [existingEvents] = await mysqlConnection.execute(`
    SELECT id FROM events 
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
  `, [eventId, req.user.userId]);
  
  if (existingEvents.length === 0) {
    return res.status(404).json({ error: 'Event not found' });
  }
  
  // Build update query dynamically
  const updateFields = [];
  const params = [];
  
  if (title !== undefined) {
    updateFields.push('title = ?');
    params.push(title.trim());
  }
  
  if (description !== undefined) {
    updateFields.push('description = ?');
    params.push(description || null);
  }
  
  if (event_type !== undefined) {
    updateFields.push('event_type = ?');
    params.push(validateEventType(event_type));
  }
  
  if (start_time !== undefined) {
    const startTime = parseDateTime(start_time);
    updateFields.push('start_time = ?');
    params.push(startTime);
  }
  
  if (end_time !== undefined) {
    const endTime = end_time ? parseDateTime(end_time) : null;
    updateFields.push('end_time = ?');
    params.push(endTime);
  }
  
  if (location !== undefined) {
    updateFields.push('location = ?');
    params.push(location || null);
  }
  
  if (is_recurring !== undefined) {
    updateFields.push('is_recurring = ?');
    params.push(!!is_recurring);
  }
  
  if (recurrence_pattern !== undefined) {
    updateFields.push('recurrence_pattern = ?');
    params.push(recurrence_pattern || null);
  }
  
  if (reminder_minutes !== undefined) {
    const reminderMins = parseInt(reminder_minutes);
    if (isNaN(reminderMins) || reminderMins < 0) {
      throw new ValidationError('Reminder minutes must be a positive number');
    }
    updateFields.push('reminder_minutes = ?');
    params.push(reminderMins);
  }
  
  if (child_id !== undefined) {
    updateFields.push('child_id = ?');
    params.push(child_id || null);
  }
  
  if (notes !== undefined) {
    updateFields.push('notes = ?');
    params.push(notes || null);
  }
  
  if (updateFields.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }
  
  updateFields.push('updated_at = NOW()');
  params.push(eventId);
  
  await mysqlConnection.execute(`
    UPDATE events SET ${updateFields.join(', ')} WHERE id = ?
  `, params);
  
  res.json({
    message: 'Event updated successfully',
    eventId: parseInt(eventId)
  });
}));

// Delete an event
app.delete('/events/:eventId', authenticateToken, asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  
  const [result] = await mysqlConnection.execute(`
    UPDATE events 
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
  `, [eventId, req.user.userId]);
  
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Event not found' });
  }
  
  res.json({
    message: 'Event deleted successfully',
    eventId: parseInt(eventId)
  });
}));

// ===============================
// CALENDAR VIEW ENDPOINTS
// ===============================

// Get calendar view (events for a specific month/week)
app.get('/calendar', authenticateToken, asyncHandler(async (req, res) => {
  const { year, month, view = 'month' } = req.query;
  
  if (!year || !month) {
    throw new ValidationError('Year and month are required');
  }
  
  let startDate, endDate;
  
  if (view === 'month') {
    startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
    endDate = new Date(parseInt(year), parseInt(month), 0);
    endDate.setHours(23, 59, 59, 999);
  } else if (view === 'week') {
    // If week view, month param represents the week number
    startDate = new Date(parseInt(year), 0, 1 + (parseInt(month) - 1) * 7);
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
  } else {
    throw new ValidationError('Invalid view type. Use "month" or "week"');
  }
  
  const [events] = await mysqlConnection.execute(`
    SELECT e.*, c.name as child_name
    FROM events e
    LEFT JOIN children c ON e.child_id = c.id
    WHERE e.user_id = ? 
    AND e.start_time >= ? 
    AND e.start_time <= ?
    AND e.deleted_at IS NULL
    ORDER BY e.start_time ASC
  `, [req.user.userId, startDate, endDate]);
  
  // Group events by date for easier frontend consumption
  const eventsByDate = {};
  events.forEach(event => {
    const dateKey = event.start_time.toISOString().split('T')[0];
    if (!eventsByDate[dateKey]) {
      eventsByDate[dateKey] = [];
    }
    eventsByDate[dateKey].push(event);
  });
  
  res.json({
    calendar: {
      view,
      start_date: startDate,
      end_date: endDate,
      events_by_date: eventsByDate,
      total_events: events.length
    }
  });
}));

// Get today's events
app.get('/today', authenticateToken, asyncHandler(async (req, res) => {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  
  const [events] = await mysqlConnection.execute(`
    SELECT e.*, c.name as child_name
    FROM events e
    LEFT JOIN children c ON e.child_id = c.id
    WHERE e.user_id = ? 
    AND e.start_time >= ? 
    AND e.start_time < ?
    AND e.deleted_at IS NULL
    ORDER BY e.start_time ASC
  `, [req.user.userId, startOfDay, endOfDay]);
  
  res.json({
    today_events: events,
    date: startOfDay,
    count: events.length
  });
}));

// Get upcoming events (next 7 days)
app.get('/upcoming', authenticateToken, asyncHandler(async (req, res) => {
  const { days = 7 } = req.query;
  const now = new Date();
  const futureDate = new Date();
  futureDate.setDate(now.getDate() + parseInt(days));
  
  const [events] = await mysqlConnection.execute(`
    SELECT e.*, c.name as child_name
    FROM events e
    LEFT JOIN children c ON e.child_id = c.id
    WHERE e.user_id = ? 
    AND e.start_time >= NOW()
    AND e.start_time <= ?
    AND e.deleted_at IS NULL
    ORDER BY e.start_time ASC
    LIMIT 20
  `, [req.user.userId, futureDate]);
  
  res.json({
    upcoming_events: events,
    period_days: parseInt(days),
    count: events.length
  });
}));

// ===============================
// APPOINTMENT MANAGEMENT
// ===============================

// Create an appointment (special type of event)
app.post('/appointments', authenticateToken, asyncHandler(async (req, res) => {
  const { 
    title, description, start_time, end_time, location,
    provider_name, provider_contact, appointment_type,
    child_id, notes, reminder_minutes = 30
  } = req.body;
  
  if (!title || !start_time || !appointment_type) {
    throw new ValidationError('Title, start time, and appointment type are required');
  }
  
  const startTime = parseDateTime(start_time);
  const endTime = end_time ? parseDateTime(end_time) : null;
  
  // Validate appointment type
  const validAppointmentTypes = [
    'medical', 'therapy', 'dental', 'vision', 'hearing', 'psychiatric',
    'educational', 'assessment', 'consultation', 'follow_up', 'other'
  ];
  
  if (!validAppointmentTypes.includes(appointment_type)) {
    throw new ValidationError('Invalid appointment type');
  }
  
  // Create as an event with appointment-specific fields
  const [result] = await mysqlConnection.execute(`
    INSERT INTO events (
      user_id, title, description, event_type, start_time, end_time,
      location, provider_name, provider_contact, appointment_type,
      child_id, notes, reminder_minutes, created_at, updated_at
    ) VALUES (?, ?, ?, 'appointment', ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
  `, [
    req.user.userId, title.trim(), description || null, startTime, endTime,
    location || null, provider_name || null, provider_contact || null,
    appointment_type, child_id || null, notes || null, parseInt(reminder_minutes)
  ]);
  
  const appointmentId = result.insertId;
  
  res.status(201).json({
    message: 'Appointment created successfully',
    appointmentId: appointmentId,
    startTime: startTime
  });
}));

// Get appointments
app.get('/appointments', authenticateToken, asyncHandler(async (req, res) => {
  const { 
    start_date, end_date, appointment_type, child_id,
    include_past = 'false', limit = 30
  } = req.query;
  
  let query = `
    SELECT e.*, c.name as child_name
    FROM events e
    LEFT JOIN children c ON e.child_id = c.id
    WHERE e.user_id = ? AND e.event_type = 'appointment' AND e.deleted_at IS NULL
  `;
  const params = [req.user.userId];
  
  // Date filtering
  if (start_date) {
    query += ' AND e.start_time >= ?';
    params.push(parseDateTime(start_date));
  }
  
  if (end_date) {
    query += ' AND e.start_time <= ?';
    params.push(parseDateTime(end_date));
  }
  
  // Don't include past appointments unless requested
  if (include_past === 'false') {
    query += ' AND e.start_time >= NOW()';
  }
  
  // Appointment type filter
  if (appointment_type) {
    query += ' AND e.appointment_type = ?';
    params.push(appointment_type);
  }
  
  // Child filter
  if (child_id) {
    query += ' AND e.child_id = ?';
    params.push(parseInt(child_id));
  }
  
  query += ' ORDER BY e.start_time ASC LIMIT ?';
  params.push(parseInt(limit));
  
  const [appointments] = await mysqlConnection.execute(query, params);
  
  res.json({
    appointments: appointments,
    count: appointments.length
  });
}));

// ===============================
// REMINDERS AND NOTIFICATIONS
// ===============================

// Get events that need reminders (for notification service)
app.get('/reminders/pending', authenticateToken, asyncHandler(async (req, res) => {
  // Get events that start within the next hour and haven't been reminded yet
  const now = new Date();
  const oneHourFromNow = new Date(now.getTime() + (60 * 60 * 1000));
  
  const [events] = await mysqlConnection.execute(`
    SELECT e.*, c.name as child_name
    FROM events e
    LEFT JOIN children c ON e.child_id = c.id
    WHERE e.user_id = ?
    AND e.start_time BETWEEN DATE_SUB(NOW(), INTERVAL e.reminder_minutes MINUTE) 
                          AND DATE_ADD(NOW(), INTERVAL 5 MINUTE)
    AND e.reminder_sent_at IS NULL
    AND e.deleted_at IS NULL
    ORDER BY e.start_time ASC
  `, [req.user.userId]);
  
  res.json({
    pending_reminders: events,
    count: events.length
  });
}));

// Mark reminder as sent
app.put('/reminders/:eventId/sent', authenticateToken, asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  
  const [result] = await mysqlConnection.execute(`
    UPDATE events 
    SET reminder_sent_at = NOW(), updated_at = NOW()
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
  `, [eventId, req.user.userId]);
  
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Event not found' });
  }
  
  res.json({
    message: 'Reminder marked as sent',
    eventId: parseInt(eventId)
  });
}));

// ===============================
// STATISTICS AND ANALYTICS
// ===============================

// Get event statistics
app.get('/stats', authenticateToken, asyncHandler(async (req, res) => {
  const { days = 30 } = req.query;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(days));
  
  try {
    // Get total events count
    const [totalEvents] = await mysqlConnection.execute(`
      SELECT COUNT(*) as total
      FROM events
      WHERE user_id = ? AND start_time >= ? AND deleted_at IS NULL
    `, [req.user.userId, startDate]);
    
    // Get events by type
    const [eventsByType] = await mysqlConnection.execute(`
      SELECT event_type, COUNT(*) as count
      FROM events
      WHERE user_id = ? AND start_time >= ? AND deleted_at IS NULL
      GROUP BY event_type
    `, [req.user.userId, startDate]);
    
    // Get appointment types breakdown
    const [appointmentTypes] = await mysqlConnection.execute(`
      SELECT appointment_type, COUNT(*) as count
      FROM events
      WHERE user_id = ? AND event_type = 'appointment' 
      AND start_time >= ? AND deleted_at IS NULL
      GROUP BY appointment_type
    `, [req.user.userId, startDate]);
    
    // Get upcoming events count
    const [upcomingEvents] = await mysqlConnection.execute(`
      SELECT COUNT(*) as upcoming
      FROM events
      WHERE user_id = ? AND start_time >= NOW() AND deleted_at IS NULL
    `, [req.user.userId]);
    
    res.json({
      statistics: {
        period_days: parseInt(days),
        start_date: startDate,
        totals: {
          events: totalEvents[0].total,
          upcoming_events: upcomingEvents[0].upcoming
        },
        breakdown: {
          by_event_type: eventsByType.reduce((acc, curr) => {
            acc[curr.event_type] = curr.count;
            return acc;
          }, {}),
          by_appointment_type: appointmentTypes.reduce((acc, curr) => {
            if (curr.appointment_type) {
              acc[curr.appointment_type] = curr.count;
            }
            return acc;
          }, {})
        }
      }
    });
  } catch (error) {
    console.error('Statistics generation error:', error);
    res.status(500).json({ error: 'Failed to generate event statistics' });
  }
}));

// Error handler
app.use((error, req, res, next) => {
  console.error('Events Service error:', error);
  
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
    
    const PORT = process.env.PORT || 3005;
    app.listen(PORT, () => {
      console.log(`📅 Events Service running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start Events Service:', error);
    process.exit(1);
  }
}

startServer();