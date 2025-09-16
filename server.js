// server.js
import 'dotenv/config';
import app from './src/app.js';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
// import notificationService from './src/services/core/notificationService.js';
// Old: import notificationService from './src/services/core/notificationService.js';
// New:
import notificationService, { notificationServiceEvents } from './src/services/core/notificationService.js';
import cluster from 'cluster';
import os from 'os';

// Environment configuration
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/notification_service';

// Cluster configuration for production
const ENABLE_CLUSTERING = process.env.ENABLE_CLUSTERING === 'true' && NODE_ENV === 'production';
const CLUSTER_WORKERS = parseInt(process.env.CLUSTER_WORKERS) || os.cpus().length;

// Create HTTP server
const server = createServer(app);

// Configure Socket.IO with production-ready settings
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ["http://localhost:5000"],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 10000,
  maxHttpBufferSize: 1e6, // 1MB
  allowEIO3: true,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  }
});

// Make io accessible in controllers
app.set('io', io);

// Connected users manager
class ConnectedUsersManager {
  constructor() {
    this.users = new Map(); // userId -> { socketId, connectedAt, lastActivity }
    this.sockets = new Map(); // socketId -> userId
  }

  addUser(userId, socketId) {
    if (this.users.has(userId)) {
      const oldSocketId = this.users.get(userId).socketId;
      this.sockets.delete(oldSocketId);
    }

    this.users.set(userId, {
      socketId,
      connectedAt: new Date(),
      lastActivity: new Date()
    });
    this.sockets.set(socketId, userId);

    console.log(`User ${userId} connected with socket ${socketId}`);
  }

  removeUser(socketId) {
    const userId = this.sockets.get(socketId);
    if (userId) {
      this.users.delete(userId);
      this.sockets.delete(socketId);
      console.log(`User ${userId} disconnected (socket: ${socketId})`);
      return userId;
    }
    return null;
  }

  getUserSocket(userId) {
    const userData = this.users.get(userId);
    return userData ? userData.socketId : null;
  }

  updateActivity(userId) {
    if (this.users.has(userId)) {
      this.users.get(userId).lastActivity = new Date();
    }
  }

  getConnectedUsers() {
    return Array.from(this.users.keys());
  }

  getStats() {
    return {
      totalConnected: this.users.size,
      users: Array.from(this.users.entries()).map(([userId, data]) => ({
        userId,
        connectedAt: data.connectedAt,
        lastActivity: data.lastActivity
      }))
    };
  }

  get(userId) {
    return this.getUserSocket(userId);
  }

  set(userId, socketId) {
    this.addUser(userId, socketId);
  }

  delete(userId) {
    const userData = this.users.get(userId);
    if (userData) {
      this.sockets.delete(userData.socketId);
      this.users.delete(userId);
    }
  }

  get size() {
    return this.users.size;
  }
}

const connectedUsers = new ConnectedUsersManager();

// Socket.IO event handling
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id} from ${socket.handshake.address}`);

  socket.use((packet, next) => {
    const [event] = packet;
    console.log(`Socket ${socket.id} emitted: ${event}`);
    next();
  });

  socket.on('register', (data) => {
    try {
      let userId;

      if (typeof data === 'string') {
        userId = data;
      } else if (data && typeof data === 'object') {
        userId = data.userId;
        if (data.token) {
          const isValidToken = validateSocketToken(data.token);
          if (!isValidToken) {
            socket.emit('error', { message: 'Invalid authentication token' });
            return;
          }
        }
      }

      if (!userId || typeof userId !== 'string') {
        socket.emit('error', { message: 'Valid userId is required' });
        return;
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
        socket.emit('error', { message: 'Invalid userId format' });
        return;
      }

      connectedUsers.addUser(userId, socket.id);
      socket.userId = userId;

      socket.join(userId);
      socket.join(`user:${userId}`);

      socket.emit('registered', {
        success: true,
        userId,
        socketId: socket.id,
        timestamp: new Date()
      });

    //   notificationService.emit('user:connected', { userId, socketId: socket.id });

      try {
  notificationServiceEvents.emit('user:connected', { userId, socketId: socket.id });
} catch (error) {
  console.error('Event emit failed:', error);  // Log but don't crash
}

    } catch (error) {
      console.error('Registration error:', error);
      socket.emit('error', { message: 'Registration failed' });
    }
  });

  socket.on('ping', () => {
    if (socket.userId) {
      connectedUsers.updateActivity(socket.userId);
    }
    socket.emit('pong', { timestamp: new Date() });
  });

  socket.on('mark_notification_read', async (data) => {
    try {
      if (!socket.userId) {
        socket.emit('error', { message: 'User not registered' });
        return;
      }

      const { notificationId } = data;
      if (!notificationId) {
        socket.emit('error', { message: 'Notification ID is required' });
        return;
      }

      await notificationService.markRead(notificationId, socket.userId);

      socket.emit('notification_marked_read', {
        notificationId,
        success: true,
        timestamp: new Date()
      });

      console.log(`Notification ${notificationId} marked as read by ${socket.userId}`);

    } catch (error) {
      console.error('Mark read error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('get_notification_count', async () => {
    try {
      if (!socket.userId) {
        socket.emit('error', { message: 'User not registered' });
        return;
      }

      const unreadCount = await notificationService.getUnreadCount(socket.userId);

      socket.emit('notification_count', {
        count: unreadCount,
        userId: socket.userId,
        timestamp: new Date()
      });

    } catch (error) {
      console.error('Get count error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('join_room', (roomName) => {
    if (socket.userId && roomName && typeof roomName === 'string') {
      socket.join(roomName);
      socket.emit('joined_room', { room: roomName, success: true });
      console.log(`User ${socket.userId} joined room: ${roomName}`);
    }
  });

  socket.on('leave_room', (roomName) => {
    if (roomName && typeof roomName === 'string') {
      socket.leave(roomName);
      socket.emit('left_room', { room: roomName, success: true });
      console.log(`User ${socket.userId} left room: ${roomName}`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`Socket ${socket.id} disconnected: ${reason}`);

    const userId = connectedUsers.removeUser(socket.id);
    if (userId) {
    //   notificationService.emit('user:disconnected', { userId, reason });
    try {
  notificationServiceEvents.emit('user:disconnected', { userId, reason });
} catch (error) {
  console.error('Event emit failed:', error);
}
    }
  });

  socket.on('error', (error) => {
    console.error(`Socket ${socket.id} error:`, error);
  });
});

function validateSocketToken(token) {
  return token && token.length > 10;
}

notificationService.init(io, connectedUsers);

async function connectDatabase() {
  const maxRetries = 5;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      await mongoose.connect(MONGODB_URI, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        bufferCommands: true,
      });

      console.log('MongoDB connected successfully');

      mongoose.connection.on('error', (error) => {
        console.error('MongoDB connection error:', error);
      });

      mongoose.connection.on('disconnected', () => {
        console.warn('MongoDB disconnected');
      });

      mongoose.connection.on('reconnected', () => {
        console.log('MongoDB reconnected');
      });

      return;
    } catch (error) {
      retryCount++;
      console.error(`MongoDB connection attempt ${retryCount}/${maxRetries} failed:`, error.message);

      if (retryCount >= maxRetries) {
        throw new Error(`Failed to connect to MongoDB after ${maxRetries} attempts`);
      }

      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
    }
  }
}

async function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Starting graceful shutdown...`);

  try {
    server.close((err) => {
      if (err) console.error('Error closing HTTP server:', err);
      else console.log('HTTP server closed');
    });

    io.close((err) => {
      if (err) console.error('Error closing Socket.IO server:', err);
      else console.log('Socket.IO server closed');
    });

    await notificationService.shutdown();
    await mongoose.connection.close();
    console.log('MongoDB connection closed');

    console.log('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

if (ENABLE_CLUSTERING && cluster.isPrimary) {
  console.log(`Master process ${process.pid} is running`);
  console.log(`Starting ${CLUSTER_WORKERS} workers...`);

  for (let i = 0; i < CLUSTER_WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
    console.log('Starting a new worker...');
    cluster.fork();
  });

} else {
  async function startServer() {
    try {
      await connectDatabase();

      server.listen(PORT, () => {
        const processInfo = ENABLE_CLUSTERING ? `Worker ${process.pid}` : `Process ${process.pid}`;

        console.log(`
🚀 Throne8 Notification Service Started
========================================
${processInfo} listening on port ${PORT}
Environment: ${NODE_ENV}
Socket.IO: Enabled
MongoDB: Connected
API Endpoints:
  - Health: http://localhost:${PORT}/health
  - API: http://localhost:${PORT}/api/v1
  - Webhooks: http://localhost:${PORT}/api/v1/webhooks
========================================
        `);
      });

      setInterval(() => {
        const stats = connectedUsers.getStats();
        console.log(`Connected users: ${stats.totalConnected}`);
      }, 60000);

    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  startServer();
}
