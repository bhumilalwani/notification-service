import 'dotenv/config';
import app from './src/app.js';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import notificationService from './src/services/core/notificationService.js';

const server = createServer(app);

// Attach Socket.IO
const io = new SocketIOServer(server, {
  cors: {
    origin: "*", // allow all origins for now; restrict in production
    methods: ["GET", "POST"]
  }
});

// ✅ Make io accessible in controllers
app.set('io', io);

// Store connected clients
const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log('⚡ Client connected:', socket.id);

  // Listen for user registering their userId
  socket.on('register', (userId) => {
    connectedUsers.set(userId, socket.id);

    // ✅ Join a room with userId so io.to(userId) works
    socket.join(userId);

    console.log(`User registered and joined room: ${userId}`);
  });

  socket.on('disconnect', () => {
    for (const [userId, id] of connectedUsers.entries()) {
      if (id === socket.id) {
        connectedUsers.delete(userId);
        console.log(`User disconnected: ${userId}`);
      }
    }
  });
});

// ✅ Inject io + connectedUsers into service
notificationService.init(io, connectedUsers);

// Connect MongoDB and start server
const PORT = process.env.PORT || 5000;

async function start() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB connected');
  server.listen(PORT, () =>
    console.log(`🚀 Notification service listening on ${PORT}`)
  );
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
