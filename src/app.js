import express from 'express';
import path from 'path';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { fileURLToPath } from 'url';
import { cleanEnv, str, port } from 'envalid';
import timeout from 'express-timeout-handler';
import winston from 'winston';
import notifRoutes from './routes/notifications.js';
import webhookRoutes from './routes/webhooks.js';
import { errorHandler } from './middleware/errorHandler.js';
import * as emailService from './services/channels/emailService.js';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import cluster from 'node:cluster';
import fs from 'fs';

// Validate environment variables
const env = cleanEnv(process.env, {
  PORT: port({ default: 5000 }),
  NODE_ENV: str({ choices: ['development', 'production', 'test'] }),
  REDIS_URL: str({ default: 'redis://localhost:6379' }),
  MONGODB_URI: str(),
  ALLOWED_ORIGINS: str({ default: 'http://localhost:5000' }),
  SENDGRID_WEBHOOK_SECRET: str({ default: '' }),
  MAILGUN_WEBHOOK_SECRET: str({ default: '' }),
});

// Initialize Express app
const app = express();

// Emulate __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure logs directory exists
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Initialize Winston logger
const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(__dirname, 'logs', 'app.log') }),
  ],
});

// Redis client for metrics
const redis = new Redis(env.REDIS_URL);

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per minute
  message: { success: false, error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// CORS configuration
const corsOptions = {
  origin: env.ALLOWED_ORIGINS.split(','), // e.g., ['http://frontend.com', 'https://app.throne8.com']
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Hub-Signature', 'X-Mailgun-Signature', 'X-Amz-Sns-Signature'],
  credentials: true,
  maxAge: 86400, // 24 hours for preflight cache
};

// Helmet configuration
const helmetOptions = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", ...env.ALLOWED_ORIGINS.split(',')],
    },
  },
  xFrameOptions: { action: 'deny' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
};

// Timeout configuration
const timeoutOptions = {
  timeout: 10000, // 10 seconds
  onTimeout: (req, res) => {
    logger.error(`Request timed out: ${req.method} ${req.originalUrl}`);
    res.status(504).json({ success: false, error: 'Request timed out' });
  },
};

// Middlewares
app.use(globalLimiter);
app.use(cors(corsOptions));
app.use(helmet(helmetOptions));
app.use(compression());
app.use(timeout.handler(timeoutOptions));
app.use(express.json()); // Replaces bodyParser.json()
app.use(morgan('combined', {
  stream: { write: message => logger.info(message.trim()) },
}));

// Serve static files with caching
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: env.NODE_ENV === 'production' ? '1y' : 0,
  etag: true,
}));

// Swagger API documentation
const swaggerDocument = {
  openapi: '3.0.0',
  info: { title: 'Throne8 Notification API', version: '1.0.0', description: 'API for managing notifications and webhooks' },
  servers: [{ url: env.NODE_ENV === 'production' ? 'https://api.throne8.com' : 'http://localhost:5000' }],
  paths: {}, // Populated by routes
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// API Routes - Mount correctly with /api/v1 prefix
app.use('/api/v1/notifications', notifRoutes);
app.use('/api/v1/webhooks', webhookRoutes);

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  const healthStatus = {
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      redis: redis.status === 'ready' ? 'connected' : 'disconnected',
      email: emailService.getHealthStatus().isInitialized ? 'healthy' : 'unhealthy',
      firebase: getFirebaseStatus().isInitialized ? 'healthy' : 'unhealthy',
    },
  };
  res.json(healthStatus);
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    success: true,
    status: 'operational',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    metrics: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      requests: globalLimiter.getStats ? globalLimiter.getStats() : null,
    },
  });
});

// 404 handler
app.use((req, res, next) => {
  logger.warn(`404 Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
    availableEndpoints: [
      'GET /health',
      'GET /status',
      'GET /api-docs',
      'POST /api/v1/notifications',
      'GET /api/v1/notifications/user/:userId',
      'POST /api/v1/webhooks'
    ]
  });
});

// Error handler
app.use(errorHandler);

// Graceful shutdown
const shutdown = async () => {
  logger.info('Initiating graceful shutdown...');
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');

    await redis.quit();
    logger.info('Redis connection closed');

    // Only call shutdown if it exists
    if (typeof emailService.shutdown === 'function') {
      await emailService.shutdown();
      logger.info('Email service shut down');
    } else {
      logger.info('Email service has no shutdown function, skipping');
    }

    process.exit(0);
  } catch (error) {
    logger.error('Shutdown error:', error);
    process.exit(1);
  }
};


process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;