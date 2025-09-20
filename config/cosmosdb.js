const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();

let client = null;
let db = null;

console.log('Cosmos connection string:', process.env.COSMOS_DB_CONNECTION_STRING);

// Cosmos DB configuration
const cosmosConfig = {
  connectionString: process.env.COSMOS_DB_CONNECTION_STRING,
  dbName: process.env.COSMOS_DB_NAME || 'caregiver_cosmos',
  options: {
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
  }
};

// Connect to Cosmos DB with retry logic
const connectCosmosDB = async (retries = 5) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (!client) {
        client = new MongoClient(cosmosConfig.connectionString, cosmosConfig.options);
      }
      
      // Connect to the client
      await client.connect();
      
      // Test the connection
      await client.db('admin').command({ ping: 1 });
      
      // Get database instance
      db = client.db(cosmosConfig.dbName);
      
      console.log(`✅ Connected to Azure Cosmos DB: ${cosmosConfig.dbName}`);
      
      // Create indexes for better performance
      await createIndexes();
      
      return { client, db };
      
    } catch (error) {
      console.error(`❌ Cosmos DB connection attempt ${i + 1} failed:`, error.message);
      
      if (client) {
        await client.close();
        client = null;
      }
      
      if (i === retries - 1) {
        console.error('❌ All Cosmos DB connection attempts failed');
        throw error;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 3000 * (i + 1)));
    }
  }
};

// Create indexes for optimal performance
const createIndexes = async () => {
  try {
    // Chat Messages Collection Indexes
    const messagesCollection = db.collection('chat_messages');
    await messagesCollection.createIndex({ chat_id: 1, created_at: -1 });
    await messagesCollection.createIndex({ sender_id: 1, created_at: -1 });
    await messagesCollection.createIndex({ created_at: -1 });
    
    // Mood Entries Collection Indexes
    const moodCollection = db.collection('mood_entries');
    await moodCollection.createIndex({ user_id: 1, date: -1 });
    await moodCollection.createIndex({ user_id: 1, created_at: -1 });
    
    // Energy Entries Collection Indexes
    const energyCollection = db.collection('energy_entries');
    await energyCollection.createIndex({ user_id: 1, date: -1 });
    await energyCollection.createIndex({ user_id: 1, created_at: -1 });
    
    // Sleep Entries Collection Indexes
    const sleepCollection = db.collection('sleep_entries');
    await sleepCollection.createIndex({ user_id: 1, sleep_date: -1 });
    await sleepCollection.createIndex({ user_id: 1, created_at: -1 });
    
    // Reflections Collection Indexes
    const reflectionsCollection = db.collection('reflections');
    await reflectionsCollection.createIndex({ user_id: 1, created_at: -1 });
    await reflectionsCollection.createIndex({ user_id: 1, date: -1 });
    
    // Care Logs Collection Indexes
    const careLogsCollection = db.collection('care_logs');
    await careLogsCollection.createIndex({ user_id: 1, log_date: -1 });
    await careLogsCollection.createIndex({ child_id: 1, log_date: -1 });
    await careLogsCollection.createIndex({ user_id: 1, created_at: -1 });
    
    // Notifications Collection Indexes
    // const notificationsCollection = db.collection('notifications');
    // await notificationsCollection.createIndex({ user_id: 1, created_at: -1 });
    // await notificationsCollection.createIndex({ user_id: 1, is_read: 1, created_at: -1 });
    
    // Emergency Contacts Collection Indexes
    // const emergencyCollection = db.collection('emergency_contacts');
    // await emergencyCollection.createIndex({ user_id: 1, priority: 1 });
    
    // AI Conversations Collection Indexes (COMMENTED OUT)
    // const aiConversationsCollection = db.collection('ai_conversations');
    // await aiConversationsCollection.createIndex({ user_id: 1, created_at: -1 });
    // await aiConversationsCollection.createIndex({ user_id: 1, conversation_id: 1 });
    
    console.log('✅ Cosmos DB indexes created successfully');
    
  } catch (error) {
    console.error('❌ Failed to create Cosmos DB indexes:', error);
    // Don't throw error - indexes are for optimization
  }
};

// Get collection with error handling
const getCollection = (collectionName) => {
  if (!db) {
    throw new Error('Cosmos DB not connected');
  }
  return db.collection(collectionName);
};

// Execute operation with retry logic
const executeWithRetry = async (operation, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      console.error(`❌ Cosmos DB operation attempt ${i + 1} failed:`, error.message);
      
      // If connection lost, try to reconnect
      if (error.name === 'MongoNetworkError' || error.name === 'MongoServerSelectionError') {
        console.log('🔄 Attempting to reconnect to Cosmos DB...');
        await connectCosmosDB();
      }
      
      if (i === maxRetries - 1) {
        throw error;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
};

// Health check
const healthCheck = async () => {
  try {
    if (!client || !db) {
      return { status: 'disconnected' };
    }
    
    await client.db('admin').command({ ping: 1 });
    
    return {
      status: 'healthy',
      timestamp: new Date(),
      database: cosmosConfig.dbName
    };
    
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date()
    };
  }
};

// Close connection
const closeConnection = async () => {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('✅ Cosmos DB connection closed');
  }
};

// Collection helpers
const collections = {
  chatMessages: () => getCollection('chat_messages'),
  moodEntries: () => getCollection('mood_entries'),
  energyEntries: () => getCollection('energy_entries'),
  sleepEntries: () => getCollection('sleep_entries'),
  reflections: () => getCollection('reflections'),
  careLogs: () => getCollection('care_logs'),
//   notifications: () => getCollection('notifications'),
//   emergencyContacts: () => getCollection('emergency_contacts'),
  // aiConversations: () => getCollection('ai_conversations'), // COMMENTED OUT
};

module.exports = {
  connectCosmosDB,
  getCollection,
  executeWithRetry,
  collections,
  healthCheck,
  closeConnection,
  getClient: () => client,
  getDatabase: () => db
};