const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const { MongoClient, ServerApiVersion } = require('mongodb');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = createServer(app);

// Socket.IO setup (using your exact pattern)
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Database connections
let mysqlConnection = null;
let mongoClient = null;
let mongoDb = null;

// Connect to MySQL (for user data)
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
    
    console.log('✅ Chat Service: MySQL connected');
  } catch (error) {
    console.error('❌ Chat Service: MySQL connection failed:', error.message);
    throw error;
  }
};

// Connect to Cosmos DB (for chat messages)
const connectCosmosDB = async () => {
  try {
    mongoClient = new MongoClient(process.env.COSMOS_DB_CONNECTION_STRING, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 120000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4,
      retryWrites: false
    });
    
    await mongoClient.connect();
    await mongoClient.db('admin').command({ ping: 1 });
    
    mongoDb = mongoClient.db(process.env.COSMOS_DB_NAME || 'caregiver_cosmos');
    
    // Create indexes for better performance
    const messagesCollection = mongoDb.collection('chat_messages');
    await messagesCollection.createIndex({ chat_id: 1, created_at: -1 });
    await messagesCollection.createIndex({ sender_id: 1, created_at: -1 });
    
    console.log('✅ Chat Service: Cosmos DB connected');
  } catch (error) {
    console.error('❌ Chat Service: Cosmos DB connection failed:', error.message);
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

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'chat-service',
    timestamp: new Date()
  });
});

// Get user's chat conversations
app.get('/conversations', authenticateToken, asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  
  // Get conversations from MySQL (chat metadata)
  const [conversations] = await mysqlConnection.execute(`
    SELECT c.*, 
           u1.name as participant1_name,
           u2.name as participant2_name,
           (SELECT content FROM chat_messages 
            WHERE chat_id = c.id 
            ORDER BY created_at DESC LIMIT 1) as last_message,
           (SELECT created_at FROM chat_messages 
            WHERE chat_id = c.id 
            ORDER BY created_at DESC LIMIT 1) as last_message_at
    FROM chats c
    LEFT JOIN users u1 ON c.participant1_id = u1.id
    LEFT JOIN users u2 ON c.participant2_id = u2.id
    WHERE (c.participant1_id = ? OR c.participant2_id = ?)
    AND c.deleted_at IS NULL
    ORDER BY c.updated_at DESC
    LIMIT ? OFFSET ?
  `, [req.user.userId, req.user.userId, parseInt(limit), parseInt(offset)]);
  
  // Get unread message counts from Cosmos DB
  const conversationsWithUnread = await Promise.all(
    conversations.map(async (conv) => {
      try {
        const messagesCollection = mongoDb.collection('chat_messages');
        const unreadCount = await messagesCollection.countDocuments({
          chat_id: conv.id,
          sender_id: { $ne: req.user.userId },
          is_read: false
        });
        
        return {
          ...conv,
          unread_count: unreadCount,
          other_participant: conv.participant1_id === req.user.userId ? {
            id: conv.participant2_id,
            name: conv.participant2_name
          } : {
            id: conv.participant1_id,
            name: conv.participant1_name
          }
        };
      } catch (error) {
        console.error('Error getting unread count:', error);
        return { ...conv, unread_count: 0 };
      }
    })
  );
  
  res.json({
    conversations: conversationsWithUnread,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit)
    }
  });
}));

// Get messages for a specific chat
app.get('/conversations/:chatId/messages', authenticateToken, asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { page = 1, limit = 50 } = req.query;
  
  // Verify user is participant in this chat
  const [chats] = await mysqlConnection.execute(`
    SELECT id FROM chats 
    WHERE id = ? AND (participant1_id = ? OR participant2_id = ?) 
    AND deleted_at IS NULL
  `, [chatId, req.user.userId, req.user.userId]);
  
  if (chats.length === 0) {
    return res.status(404).json({ error: 'Chat not found or access denied' });
  }
  
  // Get messages from Cosmos DB
  const messagesCollection = mongoDb.collection('chat_messages');
  const messages = await messagesCollection
    .find({ chat_id: parseInt(chatId) })
    .sort({ created_at: -1 })
    .limit(parseInt(limit))
    .skip((page - 1) * limit)
    .toArray();
  
  // Mark messages as read
  await messagesCollection.updateMany(
    {
      chat_id: parseInt(chatId),
      sender_id: { $ne: req.user.userId },
      is_read: false
    },
    { $set: { is_read: true, read_at: new Date() } }
  );
  
  res.json({
    messages: messages.reverse(), // Return in chronological order
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit)
    }
  });
}));

// Send a message
app.post('/conversations/:chatId/messages', authenticateToken, asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { content, message_type = 'text' } = req.body;
  
  if (!content || content.trim().length === 0) {
    throw new ValidationError('Message content is required');
  }
  
  // Verify user is participant in this chat
  const [chats] = await mysqlConnection.execute(`
    SELECT id, participant1_id, participant2_id FROM chats 
    WHERE id = ? AND (participant1_id = ? OR participant2_id = ?) 
    AND deleted_at IS NULL
  `, [chatId, req.user.userId, req.user.userId]);
  
  if (chats.length === 0) {
    return res.status(404).json({ error: 'Chat not found or access denied' });
  }
  
  const chat = chats[0];
  const recipientId = chat.participant1_id === req.user.userId ? 
    chat.participant2_id : chat.participant1_id;
  
  // Create message in Cosmos DB
  const messageId = uuidv4();
  const message = {
    message_id: messageId,
    chat_id: parseInt(chatId),
    sender_id: req.user.userId,
    recipient_id: recipientId,
    content: content.trim(),
    message_type,
    is_read: false,
    created_at: new Date(),
    updated_at: new Date()
  };
  
  const messagesCollection = mongoDb.collection('chat_messages');
  await messagesCollection.insertOne(message);
  
  // Update chat updated_at in MySQL
  await mysqlConnection.execute(
    'UPDATE chats SET updated_at = NOW() WHERE id = ?',
    [chatId]
  );
  
  // Emit message via Socket.IO (using your exact pattern)
  io.to(`chat_${chatId}`).emit('receive_message', {
    messageId: messageId,
    chatId: parseInt(chatId),
    senderId: req.user.userId,
    content: content.trim(),
    messageType: message_type,
    timestamp: new Date()
  });
  
  res.status(201).json({
    message: 'Message sent successfully',
    messageId: messageId,
    timestamp: new Date()
  });
}));

// Create a new chat conversation
app.post('/conversations', authenticateToken, asyncHandler(async (req, res) => {
  const { participant_id } = req.body;
  
  if (!participant_id) {
    throw new ValidationError('Participant ID is required');
  }
  
  if (participant_id === req.user.userId) {
    throw new ValidationError('Cannot create chat with yourself');
  }
  
  // Check if participant exists
  const [participants] = await mysqlConnection.execute(
    'SELECT id FROM users WHERE id = ? AND deleted_at IS NULL',
    [participant_id]
  );
  
  if (participants.length === 0) {
    return res.status(404).json({ error: 'Participant not found' });
  }
  
  // Check if chat already exists
  const [existingChats] = await mysqlConnection.execute(`
    SELECT id FROM chats 
    WHERE ((participant1_id = ? AND participant2_id = ?) 
           OR (participant1_id = ? AND participant2_id = ?))
    AND deleted_at IS NULL
  `, [req.user.userId, participant_id, participant_id, req.user.userId]);
  
  if (existingChats.length > 0) {
    return res.status(409).json({ 
      error: 'Chat already exists',
      chatId: existingChats[0].id
    });
  }
  
  // Create new chat
  const [result] = await mysqlConnection.execute(`
    INSERT INTO chats (participant1_id, participant2_id, created_at, updated_at)
    VALUES (?, ?, NOW(), NOW())
  `, [req.user.userId, participant_id]);
  
  const chatId = result.insertId;
  
  res.status(201).json({
    message: 'Chat created successfully',
    chatId: chatId
  });
}));

// Socket.IO connection handling (using your exact pattern)
io.on('connection', (socket) => {
  console.log('User connected to chat service:', socket.id);
  
  // Join user to their rooms
  socket.on('join_user_room', (userId) => {
    socket.join(`user_${userId}`);
    console.log(`User ${userId} joined their room`);
  });
  
  // Join chat room
  socket.on('join_chat', (chatId) => {
    socket.join(`chat_${chatId}`);
    console.log(`User joined chat: ${chatId}`);
  });
  
  // Handle chat messages (using your exact pattern)
  socket.on('send_message', async (data) => {
    try {
      // Emit to all users in the chat room
      io.to(`chat_${data.chatId}`).emit('receive_message', {
        messageId: data.messageId,
        chatId: data.chatId,
        senderId: data.senderId,
        content: data.content,
        timestamp: new Date()
      });
    } catch (error) {
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  // Handle typing indicators (using your exact pattern)
  socket.on('typing_start', (data) => {
    socket.to(`chat_${data.chatId}`).emit('user_typing', {
      userId: data.userId,
      isTyping: true
    });
  });
  
  socket.on('typing_stop', (data) => {
    socket.to(`chat_${data.chatId}`).emit('user_typing', {
      userId: data.userId,
      isTyping: false
    });
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected from chat service:', socket.id);
  });
});

// Error handler
app.use((error, req, res, next) => {
  console.error('Chat Service error:', error);
  
  if (error.name === 'ValidationError') {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }
  
  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(400).json({ error: 'Duplicate entry - this record already exists' });
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
    await connectCosmosDB();
    
    const PORT = process.env.PORT || 3003;
    server.listen(PORT, () => {
      console.log(`💬 Chat Service running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start Chat Service:', error);
    process.exit(1);
  }
}

startServer();