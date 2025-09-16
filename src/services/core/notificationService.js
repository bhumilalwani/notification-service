import Notification from '../../models/Notification.js';
import NotificationUser from '../../models/User.js';
import DeviceToken from '../../models/DeviceToken.js';
import emailService from '../channels/emailService.js';
import pushService from '../channels/pushService.js';
import mobileService from '../channels/mobileService.js';
import smsService from '../channels/smsService.js';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import AbortController from 'abort-controller'; // Added for timeout support in fetch (Node.js)

// Event emitter for core notification events
export const notificationServiceEvents = new EventEmitter();

// Service configuration
const SERVICE_CONFIG = {
  processing: {
    maxConcurrency: 100, // Max notifications processing simultaneously
    batchSize: 50, // Batch size for bulk operations
    retryDelay: 5000, // Base retry delay in milliseconds
    maxRetries: 3,
    timeout: 30000 // Max processing time per notification
  },
  channels: {
    'in-app': { enabled: true, priority: 1 },
    push: { enabled: true, priority: 2 },
    email: { enabled: true, priority: 3 },
    sms: { enabled: true, priority: 4 },
    mobile: { enabled: true, priority: 5 },
    webhook: { enabled: true, priority: 6 }
  },
  fallback: {
    enabled: true,
    channels: ['push', 'email'], // Fallback channels if primary fails
    maxFallbackAttempts: 2
  },
  rateLimit: {
    perUser: {
      hourly: 100,
      daily: 500
    },
    global: {
      perSecond: 50,
      perMinute: 1000
    }
  }
};

class NotificationService {
  constructor() {
    this.io = null;
    this.connectedUsers = new Map(); // Explicitly ensure it's a Map (fixes shutdown error)
    this.processingQueue = new Map();
    this.metrics = {
      processed: 0,
      successful: 0,
      failed: 0,
      byChannel: {},
      byType: {},
      processingTime: {
        total: 0,
        average: 0
      }
    };
    this.isInitialized = false;
    this.channelServices = new Map();
    this.initialize();
  }

  // Initialize the notification service
  async initialize() {
    try {
      // Register channel services
      this.registerChannelServices();
      // Setup monitoring
      this.setupMonitoring();
      // Setup cleanup jobs
      this.setupCleanupJobs();
      this.isInitialized = true;
      console.log('Notification service initialized successfully');
    } catch (error) {
      console.error('Failed to initialize notification service:', error);
      this.isInitialized = false;
    }
  }

  // Register available channel services
  registerChannelServices() {
    this.channelServices.set('email', emailService);
    this.channelServices.set('push', pushService);
    this.channelServices.set('mobile', mobileService);
    // Register SMS service if available
    if (smsService) {
      this.channelServices.set('sms', smsService);
    }
    console.log(`Registered ${this.channelServices.size} channel services`);
  }

  // Initialize with Socket.IO for real-time notifications
  init(io, connectedUsers = null) {
    this.io = io;
    if (connectedUsers) {
      // Ensure passed connectedUsers is a Map (prevent type issues)
      this.connectedUsers = connectedUsers instanceof Map ? connectedUsers : new Map();
    }
    // Setup socket event handlers
    if (this.io) {
      this.setupSocketHandlers();
    }
    console.log('Notification service initialized with Socket.IO');
  }

  // Setup Socket.IO event handlers
  setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      socket.on('user:connect', (userId) => {
        this.connectedUsers.set(userId, socket.id);
        console.log(`User ${userId} connected with socket ${socket.id}`);
        notificationServiceEvents.emit('user:connected', { userId, socketId: socket.id });
      });

      socket.on('user:disconnect', (userId) => {
        this.connectedUsers.delete(userId);
        console.log(`User ${userId} disconnected`);
        notificationServiceEvents.emit('user:disconnected', { userId });
      });

      socket.on('disconnect', () => {
        // Find and remove user by socket ID
        for (const [userId, socketId] of this.connectedUsers.entries()) {
          if (socketId === socket.id) {
            this.connectedUsers.delete(userId);
            console.log(`User ${userId} disconnected (socket ${socket.id})`);
            break;
          }
        }
      });
    });
  }

  // Main send function with comprehensive processing
  async send(userId, channels = ['push'], payload = {}, options = {}) {
    const startTime = Date.now();
    const correlationId = options.correlationId || this.generateCorrelationId();
    try {
      // Validate input
      this.validateSendRequest(userId, channels, payload);
      // Check rate limits
      const rateLimitCheck = await this.checkRateLimit(userId);
      if (!rateLimitCheck.allowed) {
        throw new Error(`Rate limit exceeded: ${rateLimitCheck.reason}`);
      }
      // Get user data
      const user = await this.getUserData(userId);
      if (!user) {
        throw new Error('User not found');
      }
      // Check user preferences and filter channels
      const allowedChannels = await this.filterChannelsByPreferences(user, channels, payload);
      if (allowedChannels.length === 0) {
        throw new Error('No allowed channels based on user preferences');
      }
      // Create notification record
      const notification = await this.createNotificationRecord(
        userId,
        allowedChannels,
        payload,
        options,
        correlationId
      );
      // Process notification through channels
      const result = await this.processNotification(notification, user, options);
      // Update metrics
      this.updateMetrics(result, Date.now() - startTime);
      // Emit completion event
      notificationServiceEvents.emit('notification:completed', {
        notificationId: notification.notificationId,
        userId,
        success: result.success,
        channels: allowedChannels,
        processingTime: Date.now() - startTime
      });
      return result;
    } catch (error) {
      console.error('Notification send error:', error);
      this.metrics.failed++;
      notificationServiceEvents.emit('notification:failed', {
        userId,
        error: error.message,
        correlationId
      });
      throw error;
    }
  }

  // Validate send request parameters
  validateSendRequest(userId, channels, payload) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Valid userId is required');
    }
    if (!Array.isArray(channels) || channels.length === 0) {
      throw new Error('At least one channel is required');
    }
    if (!payload || !payload.title || !payload.body) {
      throw new Error('Payload must include title and body');
    }
    // Validate channels
    const invalidChannels = channels.filter(channel => !SERVICE_CONFIG.channels[channel]?.enabled);
    if (invalidChannels.length > 0) {
      throw new Error(`Invalid or disabled channels: ${invalidChannels.join(', ')}`);
    }
  }

  // Check rate limits for user and global
  async checkRateLimit(userId) {
    try {
      // Get user for rate limit check
      const user = await NotificationUser.findOne({ userId });
      if (user && typeof user.checkRateLimit === 'function') {
        return user.checkRateLimit(); // Fixed: Guard against missing method
      }
      // If user not found or no method, allow but create user
      return { allowed: true };
    } catch (error) {
      console.error('Rate limit check failed:', error);
      return { allowed: true }; // Fail open
    }
  }

  // Get user data with caching
  async getUserData(userId) {
    try {
      // Try to get from NotificationUser first
      let user = await NotificationUser.findOne({ userId });
      if (!user) {
        // Create minimal user record
        user = new NotificationUser({
          userId,
          preferences: { enabled: true }
        });
        await user.save();
        console.log(`Created user record for: ${userId}`);
      }
      return user;
    } catch (error) {
      console.error('Error getting user data:', error);
      return null;
    }
  }

  // Filter channels based on user preferences
  async filterChannelsByPreferences(user, channels, payload) {
    const allowedChannels = [];
    for (const channel of channels) {
      if (user.canReceiveNotification(payload.type || 'general', channel, payload.priority || 'medium')) {
        allowedChannels.push(channel);
      } else {
        console.log(`Channel ${channel} blocked by user preferences for ${user.userId}`);
      }
    }
    return allowedChannels;
  }

  // Create notification database record
  async createNotificationRecord(userId, channels, payload, options, correlationId) {
    const notificationData = {
      userId,
      channels,
      title: payload.title,
      body: payload.body,
      type: payload.type || 'general',
      priority: payload.priority || 'medium',
      urgency: payload.urgency || 'normal',
      data: {
        ...payload.data,
        correlationId,
        source: options.source || 'api',
        timestamp: new Date()
      },
      'scheduling.scheduledFor': options.scheduledFor,
      status: options.scheduledFor ? 'queued' : 'pending'
    };
    const notification = await Notification.create(notificationData);
    console.log(`Created notification ${notification.notificationId} for user ${userId}`);
    return notification;
  }

  // Main notification processing function
  async processNotification(notification, user = null, options = {}) {
    const startTime = Date.now();
    try {
      // Update status to sending
      notification.status = 'sending';
      notification.processing.startedAt = new Date();
      await notification.save();
      // Get user if not provided
      if (!user) {
        user = await this.getUserData(notification.userId);
      }
      // Process through channels
      const channelResults = await this.processChannels(notification, user, options);
      // Determine overall success
      const successfulChannels = Object.values(channelResults).filter(r => r.success);
      const overallSuccess = successfulChannels.length > 0;
      // Update notification status
      notification.status = overallSuccess ? 'sent' : 'failed';
      notification.processing.completedAt = new Date();
      notification.processing.processingTime = Date.now() - startTime;
      // Update delivery status for each channel
      for (const [channel, result] of Object.entries(channelResults)) {
        notification.updateDeliveryStatus(channel, result.success ? 'sent' : 'failed', result.metadata || {});
      }
      await notification.save();
      // Update user metrics
      if (overallSuccess && user) {
        await user.recordNotificationReceived(notification.channels[0]);
      }
      return {
        success: overallSuccess,
        notificationId: notification.notificationId,
        channels: notification.channels,
        results: channelResults,
        processingTime: Date.now() - startTime
      };
    } catch (error) {
      console.error('Notification processing error:', error);
      // Update notification with error
      notification.status = 'failed';
      notification.processing.lastError = {
        message: error.message,
        timestamp: new Date(),
        stack: error.stack
      };
      await notification.save();
      throw error;
    }
  }

  // Process notification through all channels
  async processChannels(notification, user, options = {}) {
    const results = {};
    const channels = notification.channels || [];
    // Sort channels by priority
    const sortedChannels = channels.sort((a, b) => {
      const priorityA = SERVICE_CONFIG.channels[a]?.priority || 999;
      const priorityB = SERVICE_CONFIG.channels[b]?.priority || 999;
      return priorityA - priorityB;
    });
    // Process channels in parallel (with some channels having dependencies)
    const channelPromises = sortedChannels.map(async (channel) => {
      try {
        const result = await this.processChannel(channel, notification, user, options);
        results[channel] = result;
        return result;
      } catch (error) {
        console.error(`Channel ${channel} processing failed:`, error);
        results[channel] = {
          success: false,
          error: error.message,
          channel
        };
        return results[channel];
      }
    });
    await Promise.allSettled(channelPromises);
    return results;
  }

  // Process individual channel
  async processChannel(channel, notification, user, options = {}) {
    const startTime = Date.now();
    try {
      console.log(`Processing ${channel} for notification ${notification.notificationId}`);
      // Prepare payload for channel
      const channelPayload = this.prepareChannelPayload(notification, channel, options);
      let result;
      switch (channel) {
        case 'in-app':
          result = await this.processInAppChannel(notification, user, channelPayload);
          break;
        case 'email':
          result = await this.processEmailChannel(notification, user, channelPayload);
          break;
        case 'push':
          result = await this.processPushChannel(notification, user, channelPayload);
          break;
        case 'mobile':
          result = await this.processMobileChannel(notification, user, channelPayload);
          break;
        case 'sms':
          result = await this.processSMSChannel(notification, user, channelPayload);
          break;
        case 'webhook':
          result = await this.processWebhookChannel(notification, user, channelPayload);
          break;
        default:
          throw new Error(`Unsupported channel: ${channel}`);
      }
      const processingTime = Date.now() - startTime;
      console.log(`${channel} processed in ${processingTime}ms: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      return {
        ...result,
        channel,
        processingTime
      };
    } catch (error) {
      console.error(`Channel ${channel} error:`, error);
      return {
        success: false,
        error: error.message,
        channel,
        processingTime: Date.now() - startTime
      };
    }
  }

  // Prepare payload specific to channel
  prepareChannelPayload(notification, channel, options = {}) {
    const basePayload = {
      notificationId: notification.notificationId,
      title: notification.title,
      body: notification.body,
      type: notification.type,
      priority: notification.priority,
      data: notification.data,
      actions: notification.data?.actions,
      ...options.channelOverrides?.[channel]
    };
    // Channel-specific enhancements
    switch (channel) {
      case 'email':
        return {
          ...basePayload,
          template: options.emailTemplate || notification.data?.template,
          tracking: options.emailTracking !== false
        };
      case 'push':
      case 'mobile':
        return {
          ...basePayload,
          badge: notification.data?.badge,
          sound: notification.data?.sound,
          vibrate: notification.data?.vibrate,
          image: notification.data?.image
        };
      case 'sms':
        return {
          ...basePayload,
          // SMS has character limits
          body: notification.body.substring(0, 160)
        };
      default:
        return basePayload;
    }
  }

  // Process in-app channel (Socket.IO)
  async processInAppChannel(notification, user, payload) {
    try {
      const socketId = this.connectedUsers.get(user.userId);
      if (!socketId || !this.io) {
        return {
          success: false,
          error: 'User not connected or Socket.IO not available',
          metadata: { userConnected: !!socketId, socketIOAvailable: !!this.io }
        };
      }
      // Emit to specific socket
      await this.io.to(socketId).emit('notification', {
        id: notification._id,
        notificationId: notification.notificationId,
        title: payload.title,
        body: payload.body,
        type: payload.type,
        priority: payload.priority,
        data: payload.data,
        actions: payload.actions,
        timestamp: new Date()
      });
      console.log(`In-app notification sent to socket ${socketId} for user ${user.userId}`);
      return {
        success: true,
        metadata: {
          socketId,
          deliveredAt: new Date()
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Process email channel
  async processEmailChannel(notification, user, payload) {
    try {
      const emailService = this.channelServices.get('email');
      if (!emailService) {
        throw new Error('Email service not available');
      }
      const result = await emailService.send(user.userId, payload, {
        template: payload.template,
        tracking: payload.tracking
      });
      return {
        success: result.success,
        error: result.error,
        metadata: {
          messageId: result.messageId,
          provider: result.provider
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Process push channel
  async processPushChannel(notification, user, payload) {
    try {
      const pushService = this.channelServices.get('push');
      if (!pushService) {
        throw new Error('Push service not available');
      }
      const result = await pushService.send(user.userId, payload);
      return {
        success: result.success,
        error: result.error,
        metadata: {
          subscriptions: result.totalSubscriptions,
          sent: result.sent,
          failed: result.failed
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Process mobile channel
  async processMobileChannel(notification, user, payload) {
    try {
      const mobileService = this.channelServices.get('mobile');
      if (!mobileService) {
        throw new Error('Mobile service not available');
      }
      const result = await mobileService.send(user.userId, payload);
      return {
        success: result.success,
        error: result.error,
        metadata: {
          tokens: result.totalTokens,
          sent: result.sentTo,
          failed: result.failed,
          providers: Object.keys(result.providerResults || {})
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Process SMS channel
  async processSMSChannel(notification, user, payload) {
    try {
      const smsService = this.channelServices.get('sms');
      if (!smsService) {
        throw new Error('SMS service not available');
      }
      const result = await smsService.send(user.userId, payload);
      return {
        success: result.success,
        error: result.error,
        metadata: {
          messageId: result.messageId,
          provider: result.provider,
          cost: result.cost
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Process webhook channel
  async processWebhookChannel(notification, user, payload) {
    try {
      // Get user's webhook URLs
      const webhookUrls = user.integrations?.webhooks || [];
      if (webhookUrls.length === 0) {
        return {
          success: false,
          error: 'No webhook URLs configured for user'
        };
      }
      const results = await Promise.allSettled(
        webhookUrls.map(webhook => this.sendWebhook(webhook, payload))
      );
      const successful = results.filter(r => r.status === 'fulfilled' && r.value.success);
      return {
        success: successful.length > 0,
        metadata: {
          totalWebhooks: webhookUrls.length,
          successful: successful.length,
          failed: results.length - successful.length
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Send webhook (Fixed: Added AbortController for timeout)
  async sendWebhook(webhook, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
    try {
      const response = await fetch(webhook.url, {
        method: webhook.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Throne8-Notification-Service/1.0',
          ...webhook.headers
        },
        body: JSON.stringify({
          ...payload,
          timestamp: new Date().toISOString(),
          webhook: {
            id: webhook.id,
            event: 'notification.sent'
          }
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return {
        success: response.ok,
        statusCode: response.status,
        responseTime: Date.now()
      };
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Generate correlation ID
  generateCorrelationId() {
    return crypto.randomBytes(16).toString('hex');
  }

  // Update service metrics
  updateMetrics(result, processingTime) {
    this.metrics.processed++;
    if (result.success) {
      this.metrics.successful++;
    } else {
      this.metrics.failed++;
    }
    // Update processing time metrics
    this.metrics.processingTime.total += processingTime;
    this.metrics.processingTime.average = this.metrics.processingTime.total / this.metrics.processed;
    // Update channel metrics
    if (result.results) {
      Object.keys(result.results).forEach(channel => {
        if (!this.metrics.byChannel[channel]) {
          this.metrics.byChannel[channel] = { sent: 0, failed: 0 };
        }
        if (result.results[channel].success) {
          this.metrics.byChannel[channel].sent++;
        } else {
          this.metrics.byChannel[channel].failed++;
        }
      });
    }
  }

  // Send bulk notifications
  async sendBulk(notifications, options = {}) {
    const { batchSize = SERVICE_CONFIG.processing.batchSize } = options;
    const results = [];
    const errors = [];
    // Process in batches
    for (let i = 0; i < notifications.length; i += batchSize) {
      const batch = notifications.slice(i, i + batchSize);
      const batchPromises = batch.map(async (notification) => {
        try {
          const result = await this.send(
            notification.userId,
            notification.channels,
            notification.payload,
            notification.options
          );
          return {
            success: true,
            userId: notification.userId,
            notificationId: result.notificationId,
            result
          };
        } catch (error) {
          return {
            success: false,
            userId: notification.userId,
            error: error.message
          };
        }
      });
      const batchResults = await Promise.allSettled(batchPromises);
      batchResults.forEach(result => {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            results.push(result.value);
          } else {
            errors.push(result.value);
          }
        } else {
          errors.push({
            success: false,
            error: result.reason.message
          });
        }
      });
    }
    return {
      success: true,
      total: notifications.length,
      successful: results.length,
      failed: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  // List notifications with enhanced filtering
  async list(userId, options = {}) {
    const { limit = 50, skip = 0, type, status, startDate, endDate, includeDeleted = false } = options;
    const query = { userId };
    if (type) query.type = type;
    if (status) query.status = status;
    if (!includeDeleted) query['deletion.isDeleted'] = false;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();
    const totalCount = await Notification.countDocuments(query);
    return {
      notifications,
      pagination: {
        total: totalCount,
        limit,
        skip,
        hasMore: totalCount > skip + limit
      }
    };
  }

  // Mark notification as read
  async markRead(notificationId, userId = null) {
    try {
      const query = { _id: notificationId };
      if (userId) query.userId = userId;
      const notification = await Notification.findOne(query);
      if (!notification) {
        throw new Error('Notification not found');
      }
      await notification.markAsSeen();
      // Update user engagement
      const user = await NotificationUser.findOne({ userId: notification.userId });
      if (user) {
        await user.recordNotificationEngagement('seen', 'in-app');
      }
      return notification;
    } catch (error) {
      console.error('Mark read error:', error);
      throw error;
    }
  }

  // Setup monitoring and reporting
  setupMonitoring() {
    // Report metrics every hour
    setInterval(() => {
      console.log('Notification service metrics:', this.metrics);
      notificationServiceEvents.emit('metrics:hourly', {
        ...this.metrics,
        timestamp: new Date(),
        connectedUsers: this.connectedUsers.size
      });
    }, 60 * 60 * 1000); // 1 hour
    // Reset daily metrics
    setInterval(() => {
      this.resetDailyMetrics();
    }, 24 * 60 * 60 * 1000); // 24 hours
  }

  // Setup cleanup jobs
  setupCleanupJobs() {
    // Process pending notifications every minute
    setInterval(async () => {
      await this.processPendingNotifications();
    }, 60 * 1000); // 1 minute
    // Retry failed notifications every 5 minutes
    setInterval(async () => {
      await this.retryFailedNotifications();
    }, 5 * 60 * 1000); // 5 minutes
  }

  // Process pending scheduled notifications
  async processPendingNotifications() {
    try {
      const pendingNotifications = await Notification.find({
        status: 'queued',
        'scheduling.scheduledFor': { $lte: new Date() },
        'deletion.isDeleted': false
      }).limit(100);
      for (const notification of pendingNotifications) {
        try {
          const user = await this.getUserData(notification.userId);
          await this.processNotification(notification, user);
        } catch (error) {
          console.error(`Failed to process pending notification ${notification.notificationId}:`, error);
        }
      }
      if (pendingNotifications.length > 0) {
        console.log(`Processed ${pendingNotifications.length} pending notifications`);
      }
    } catch (error) {
      console.error('Error processing pending notifications:', error);
    }
  }

  // Retry failed notifications
  async retryFailedNotifications() {
    try {
      const failedNotifications = await Notification.findForRetry(50);
      for (const notification of failedNotifications) {
        try {
          notification.incrementRetry();
          const user = await this.getUserData(notification.userId);
          await this.processNotification(notification, user);
        } catch (error) {
          console.error(`Failed to retry notification ${notification.notificationId}:`, error);
        }
      }
      if (failedNotifications.length > 0) {
        console.log(`Retried ${failedNotifications.length} failed notifications`);
      }
    } catch (error) {
      console.error('Error retrying failed notifications:', error);
    }
  }

  // Reset daily metrics
  resetDailyMetrics() {
    const oldMetrics = { ...this.metrics };
    this.metrics = {
      processed: 0,
      successful: 0,
      failed: 0,
      byChannel: {},
      byType: {},
      processingTime: {
        total: 0,
        average: 0
      }
    };
    notificationServiceEvents.emit('metrics:daily_reset', {
      previousDay: oldMetrics,
      timestamp: new Date()
    });
    console.log('Daily metrics reset');
  }

  // Get service health status
  getHealthStatus() {
    const successRate = this.metrics.processed > 0
      ? (this.metrics.successful / this.metrics.processed) * 100
      : 100;
    return {
      status: this.isInitialized && successRate >= 95 ? 'healthy' : 'degraded',
      metrics: {
        ...this.metrics,
        successRate: Math.round(successRate * 100) / 100,
        averageProcessingTime: this.metrics.processingTime.average
      },
      channels: {
        registered: Array.from(this.channelServices.keys()),
        enabled: Object.keys(SERVICE_CONFIG.channels).filter(
          channel => SERVICE_CONFIG.channels[channel].enabled
        )
      },
      realtime: {
        socketIOEnabled: !!this.io,
        connectedUsers: this.connectedUsers.size
      },
      isInitialized: this.isInitialized,
      uptime: process.uptime(),
      timestamp: new Date()
    };
  }

  // Get detailed analytics (Fixed: Added try-catch for aggregation errors)
  async getAnalytics(options = {}) {
    const { startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), endDate = new Date(), groupBy = 'day' } = options;
    try {
      // Get notification counts by status
      const statusStats = await Notification.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate, $lte: endDate },
            'deletion.isDeleted': false
          }
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]);
      // Get notifications by channel
      const channelStats = await Notification.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate, $lte: endDate },
            'deletion.isDeleted': false
          }
        },
        { $unwind: '$channels' },
        {
          $group: {
            _id: '$channels',
            count: { $sum: 1 },
            successful: {
              $sum: {
                $cond: [{ $eq: ['$status', 'sent'] }, 1, 0]
              }
            }
          }
        }
      ]);
      // Get notifications by type
      const typeStats = await Notification.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate, $lte: endDate },
            'deletion.isDeleted': false
          }
        },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            successful: {
              $sum: {
                $cond: [{ $eq: ['$status', 'sent'] }, 1, 0]
              }
            }
          }
        }
      ]);
      return {
        period: { startDate, endDate },
        summary: {
          total: statusStats.reduce((sum, stat) => sum + stat.count, 0),
          byStatus: statusStats.reduce((acc, stat) => {
            acc[stat._id] = stat.count;
            return acc;
          }, {}),
          byChannel: channelStats.reduce((acc, stat) => {
            acc[stat._id] = {
              total: stat.count,
              successful: stat.successful,
              successRate: stat.count > 0 ? (stat.successful / stat.count) * 100 : 0
            };
            return acc;
          }, {}),
          byType: typeStats.reduce((acc, stat) => {
            acc[stat._id] = {
              total: stat.count,
              successful: stat.successful,
              successRate: stat.count > 0 ? (stat.successful / stat.count) * 100 : 0
            };
            return acc;
          }, {})
        },
        currentMetrics: this.metrics
      };
    } catch (error) {
      console.error('Analytics generation error:', error);
      return { error: error.message, period: { startDate, endDate } }; // Fixed: Graceful fallback
    }
  }

  // Test notification service
  async testService(userId = 'test-user', options = {}) {
    const testPayload = {
      title: 'Test Notification - Throne8',
      body: 'This is a test notification from the notification service.',
      type: 'system',
      priority: 'low',
      data: {
        test: true,
        timestamp: new Date().toISOString(),
        ...options.data
      }
    };
    const testChannels = options.channels || ['push'];
    try {
      const result = await this.send(userId, testChannels, testPayload, {
        source: 'test',
        ...options
      });
      return {
        success: result.success,
        notificationId: result.notificationId,
        channels: testChannels,
        processingTime: result.processingTime,
        results: result.results,
        timestamp: new Date()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        channels: testChannels,
        timestamp: new Date()
      };
    }
  }

  // Graceful shutdown (Fixed: Added guard for connectedUsers.clear())
  async shutdown() {
    try {
      console.log('Shutting down notification service...');
      // Stop processing new notifications
      this.isInitialized = false;
      // Wait for ongoing operations to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      // Close Socket.IO connections
      if (this.io) {
        this.io.close();
      }
      // Clear connected users (with guard to prevent TypeError)
      if (this.connectedUsers && typeof this.connectedUsers.clear === 'function') {
        this.connectedUsers.clear();
      }
      console.log('Notification service shutdown complete');
    } catch (error) {
      console.error('Notification service shutdown error:', error);
    }
  }
}

// Create singleton instance
const notificationService = new NotificationService();

// Handle process shutdown
process.on('SIGTERM', () => {
  notificationService.shutdown();
});

process.on('SIGINT', () => {
  notificationService.shutdown();
});

// Enhanced notification service with utility methods
class EnhancedNotificationService extends NotificationService {
  // Send notification with template
  async sendWithTemplate(userId, templateId, templateData, channels = ['push'], options = {}) {
    // This would integrate with a template service
    const payload = {
      title: `Template ${templateId}`,
      body: 'Templated notification',
      type: 'template',
      data: {
        templateId,
        templateData,
        ...options.data
      }
    };
    return this.send(userId, channels, payload, {
      ...options,
      template: templateId
    });
  }

  // Send notification to multiple users
  async sendToUsers(userIds, channels, payload, options = {}) {
    const notifications = userIds.map(userId => ({
      userId,
      channels,
      payload,
      options
    }));
    return this.sendBulk(notifications, options);
  }

  // Send notification based on user segments
  async sendToSegment(segmentCriteria, channels, payload, options = {}) {
    try {
      // Find users matching criteria
      const users = await NotificationUser.find(segmentCriteria).select('userId');
      const userIds = users.map(user => user.userId);
      if (userIds.length === 0) {
        return {
          success: false,
          error: 'No users found matching segment criteria'
        };
      }
      return this.sendToUsers(userIds, channels, payload, {
        ...options,
        segment: true,
        segmentSize: userIds.length
      });
    } catch (error) {
      throw new Error(`Segment notification failed: ${error.message}`);
    }
  }

  // Send scheduled notification
  async scheduleNotification(userId, channels, payload, scheduleTime, options = {}) {
    if (new Date(scheduleTime) <= new Date()) {
      throw new Error('Schedule time must be in the future');
    }
    return this.send(userId, channels, payload, {
      ...options,
      scheduledFor: new Date(scheduleTime)
    });
  }

  // Cancel scheduled notification
  async cancelScheduledNotification(notificationId) {
    try {
      const notification = await Notification.findOne({
        notificationId,
        status: 'queued'
      });
      if (!notification) {
        return {
          success: false,
          error: 'Scheduled notification not found'
        };
      }
      notification.status = 'cancelled';
      await notification.save();
      return {
        success: true,
        notificationId,
        cancelledAt: new Date()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get user notification preferences
  async getUserPreferences(userId) {
    try {
      const user = await NotificationUser.findOne({ userId });
      if (!user) {
        return {
          success: false,
          error: 'User not found'
        };
      }
      return {
        success: true,
        preferences: user.preferences,
        channels: user.preferences.channels,
        quietHours: user.preferences.quietHours
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Update user notification preferences
  async updateUserPreferences(userId, preferences) {
    try {
      const user = await NotificationUser.findOne({ userId });
      if (!user) {
        return {
          success: false,
          error: 'User not found'
        };
      }
      await user.updatePreferences(preferences);
      return {
        success: true,
        preferences: user.preferences
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

// Export enhanced service instance
const enhancedNotificationService = new EnhancedNotificationService();

// Export both the enhanced service and event emitter
export default enhancedNotificationService;
// export { notificationServiceEvents };

// Export individual methods for direct use
export const send = (userId, channels, payload, options) =>
  enhancedNotificationService.send(userId, channels, payload, options);

export const sendBulk = (notifications, options) =>
  enhancedNotificationService.sendBulk(notifications, options);

export const sendWithTemplate = (userId, templateId, templateData, channels, options) =>
  enhancedNotificationService.sendWithTemplate(userId, templateId, templateData, channels, options);

export const sendToUsers = (userIds, channels, payload, options) =>
  enhancedNotificationService.sendToUsers(userIds, channels, payload, options);

export const sendToSegment = (segmentCriteria, channels, payload, options) =>
  enhancedNotificationService.sendToSegment(segmentCriteria, channels, payload, options);

export const scheduleNotification = (userId, channels, payload, scheduleTime, options) =>
  enhancedNotificationService.scheduleNotification(userId, channels, payload, scheduleTime, options);

export const list = (userId, options) =>
  enhancedNotificationService.list(userId, options);

export const markRead = (notificationId, userId) =>
  enhancedNotificationService.markRead(notificationId, userId);

export const getHealthStatus = () =>
  enhancedNotificationService.getHealthStatus();
    
export const getAnalytics = (options) =>
  enhancedNotificationService.getAnalytics(options);

export const testService = (userId, options) =>
  enhancedNotificationService.testService(userId, options);