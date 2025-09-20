const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Service URLs
const services = {
  auth: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
  user: process.env.USER_SERVICE_URL || 'http://localhost:3002',
  chat: process.env.CHAT_SERVICE_URL || 'http://localhost:3003',
  tracking: process.env.TRACKING_SERVICE_URL || 'http://localhost:3004',
  events: process.env.EVENT_SERVICE_URL || 'http://localhost:3005',
//   notifications: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3006',
  ai: process.env.AI_SERVICE_URL || 'http://localhost:3007', // COMMENTED OUT
};

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    service: 'api-gateway',
    services: Object.keys(services)
  });
});

// Proxy configuration with error handling
const createProxy = (target, pathRewrite = {}) => {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite,
    timeout: 30000,
    proxyTimeout: 30000,
    onError: (err, req, res) => {
      console.error(`Proxy error for ${target}:`, err.message);
      if (!res.headersSent) {
        res.status(503).json({
          error: 'Service temporarily unavailable',
          service: target,
          timestamp: new Date()
        });
      }
    },
    onProxyReq: (proxyReq, req, res) => {
      // Add request ID for tracing
      const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      proxyReq.setHeader('x-request-id', requestId);
      proxyReq.setHeader('x-forwarded-for', req.ip);
    },
    onProxyRes: (proxyRes, req, res) => {
      // Add CORS headers
      proxyRes.headers['access-control-allow-origin'] = process.env.CORS_ORIGIN || 'http://localhost:3000';
      proxyRes.headers['access-control-allow-credentials'] = 'true';
    }
  });
};

// Route proxies
app.use('/api/auth', createProxy(services.auth, { '^/api/auth': '' }));
app.use('/api/users', createProxy(services.user, { '^/api/users': '' }));
app.use('/api/chats', createProxy(services.chat, { '^/api/chats': '' }));
app.use('/api/tracking', createProxy(services.tracking, { '^/api/tracking': '' }));
app.use('/api/events', createProxy(services.events, { '^/api/events': '' }));
// app.use('/api/notifications', createProxy(services.notifications, { '^/api/notifications': '' }));
app.use('/api/ai', createProxy(services.ai, { '^/api/ai': '' })); // COMMENTED OUT

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
    timestamp: new Date()
  });
});

// Error handler
app.use((error, req, res, next) => {
  console.error('API Gateway error:', error);
  res.status(500).json({
    error: 'Internal server error',
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 API Gateway running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log('🔗 Proxying to services:', services);
});
