const mysql = require('mysql2/promise');
require('dotenv').config();

let pool = null;

// MySQL connection configuration
const dbConfig = {
  host: process.env.AZURE_MYSQL_HOST,
  user: process.env.AZURE_MYSQL_USER,
  password: process.env.AZURE_MYSQL_PASSWORD,
  database: process.env.AZURE_MYSQL_DATABASE,
  port: process.env.AZURE_MYSQL_PORT || 3306,
  ssl: {
    rejectUnauthorized: false // Required for Azure MySQL
  },
  connectionLimit: 10,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true,
  charset: 'utf8mb4'
};

// Create connection pool
const createPool = () => {
  try {
    pool = mysql.createPool(dbConfig);
    console.log('✅ MySQL connection pool created');
    return pool;
  } catch (error) {
    console.error('❌ Failed to create MySQL pool:', error);
    throw error;
  }
};

// Connect to MySQL with retry logic
const connectMySQL = async (retries = 5) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (!pool) {
        pool = createPool();
      }
      
      // Test the connection
      const connection = await pool.getConnection();
      await connection.ping();
      connection.release();
      
      console.log(`✅ Connected to Azure MySQL database: ${process.env.AZURE_MYSQL_DATABASE}`);
      return pool;
      
    } catch (error) {
      console.error(`❌ MySQL connection attempt ${i + 1} failed:`, error.message);
      
      if (i === retries - 1) {
        console.error('❌ All MySQL connection attempts failed');
        throw error;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
    }
  }
};

// Execute query with error handling
const executeQuery = async (query, params = []) => {
  try {
    if (!pool) {
      await connectMySQL();
    }
    
    const [rows] = await pool.execute(query, params);
    return rows;
    
  } catch (error) {
    console.error('❌ MySQL query error:', error);
    
    // Retry connection if connection lost
    if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNRESET') {
      console.log('🔄 Retrying MySQL connection...');
      pool = null;
      await connectMySQL();
      const [rows] = await pool.execute(query, params);
      return rows;
    }
    
    throw error;
  }
};

// Execute transaction
const executeTransaction = async (queries) => {
  let connection = null;
  
  try {
    if (!pool) {
      await connectMySQL();
    }
    
    connection = await pool.getConnection();
    await connection.beginTransaction();
    
    const results = [];
    for (const { query, params } of queries) {
      const [result] = await connection.execute(query, params);
      results.push(result);
    }
    
    await connection.commit();
    return results;
    
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('❌ MySQL transaction error:', error);
    throw error;
    
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Get pool stats
const getPoolStats = () => {
  if (!pool) return null;
  
  return {
    totalConnections: pool.pool._allConnections.length,
    freeConnections: pool.pool._freeConnections.length,
    usedConnections: pool.pool._allConnections.length - pool.pool._freeConnections.length
  };
};

// Close pool
const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('✅ MySQL pool closed');
  }
};

// Health check
const healthCheck = async () => {
  try {
    if (!pool) {
      return { status: 'disconnected' };
    }
    
    const connection = await pool.getConnection();
    const [rows] = await connection.execute('SELECT 1 as health_check');
    connection.release();
    
    return {
      status: 'healthy',
      timestamp: new Date(),
      poolStats: getPoolStats()
    };
    
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date()
    };
  }
};

module.exports = {
  connectMySQL,
  executeQuery,
  executeTransaction,
  getPool: () => pool,
  getPoolStats,
  closePool,
  healthCheck
};