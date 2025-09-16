import Notification from '../models/Notification.js';
import NotificationUser from '../models/User.js';
import DeviceToken from '../models/DeviceToken.js';
import { validationResult, body, param, query } from 'express-validator';
// import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';
import notificationService from '../services/core/notificationService.js';
import pushService from '../services/channels/pushService.js';
import emailService from '../services/channels/emailService.js';
import smsService from '../services/channels/smsService.js';
import Redis from 'ioredis';
import validator from 'validator';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import RateLimitRedisStore from 'rate-limit-redis';

// Initialize Redis client with error handling
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryDelayOnFailover: 100,
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  family: 4,
});

redis.on('error', (error) => console.error('Redis error:', error));

// Redis error handling
redis.on('error', (error) => {
  console.error('Redis connection error:', error);
});

redis.on('connect', () => {
  console.log('Redis connected successfully');
});

// Rate limiter for sending notifications
const sendNotificationLimiter = rateLimit({
  store: new RateLimitRedisStore({ sendCommand: (...args) => redis.call(...args) }),
  windowMs: 60 * 1000, // 1 minute
  max: 50,
  message: { success: false, error: 'Too many notification requests, try again later' },
  keyGenerator: (req) => {
    const ip = ipKeyGenerator(req); // Normalize IP address
    return `send_notif_${ip}_${req.body?.userId || 'unknown'}`;
  },
});

// Rate limiter for getting user notifications
const getUserNotificationsLimiter = rateLimit({
  store: new RateLimitRedisStore({ sendCommand: (...args) => redis.call(...args) }),
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: { success: false, error: 'Too many requests, try again later' },
keyGenerator: (req) => {
    const ip = ipKeyGenerator(req); // Normalize IP address
    return `get_notif_${ip}_${req.params?.userId || 'unknown'}`;
  },
});

// Enhanced validation middleware
export const validateSendNotification = [
  body('userId')
    .notEmpty()
    .isLength({ min: 1, max: 50 })
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Valid userId is required'),
  body('channels')
    .isArray({ min: 1 })
    .custom(channels => channels.every(channel => ['email', 'push', 'sms', 'mobile', 'in-app', 'slack', 'teams'].includes(channel)))
    .withMessage('Invalid channel specified'),
  body('title')
    .notEmpty()
    .isLength({ min: 1, max: 200 })
    .trim()
    .escape()
    .withMessage('Title is required and must be 1-200 characters'),
  body('body')
    .notEmpty()
    .isLength({ min: 1, max: 1000 })
    .trim()
    .escape()
    .withMessage('Body is required and must be 1-1000 characters'),
  body('type')
    .optional()
    .isIn([
      'general', 'security', 'marketing', 'system', 'urgent', 'promotional', 'reminder', 'social',
      'payment', 'order', 'message', 'alert', 'like', 'comment', 'follow', 'connection_request',
      'job_alert', 'mention', 'share', 'endorsement', 'profile_view', 'birthday', 'work_anniversary',
      'group_invite', 'event_invite', 'content_update'
    ])
    .withMessage('Invalid notification type'),
  body('priority')
    .optional()
    .isIn(['critical', 'high', 'medium', 'low'])
    .withMessage('Invalid priority level'),
  body('scheduledFor')
    .optional()
    .isISO8601()
    .custom(value => new Date(value) > new Date())
    .withMessage('Scheduled time must be in the future'),
  body('data')
    .optional()
    .isObject()
    .custom(data => {
      try {
        const jsonString = JSON.stringify(data);
        return jsonString.length <= 2048;
      } catch (error) {
        return false;
      }
    })
    .withMessage('Data object too large (max 2KB) or invalid'),
  body('richContent')
    .optional()
    .isObject()
    .custom(richContent => {
      try {
        if (richContent.html && richContent.html.length > 2000) return false;
        if (richContent.markdown && richContent.markdown.length > 2000) return false;
        if (richContent.attachments) {
          return Array.isArray(richContent.attachments) &&
                 richContent.attachments.every(att => 
                   ['image', 'file', 'video', 'audio'].includes(att.type) && 
                   att.url && 
                   typeof att.url === 'string' && 
                   att.url.length <= 500 &&
                   validator.isURL(att.url)
                 );
        }
        return true;
      } catch (error) {
        return false;
      }
    })
    .withMessage('Invalid richContent format'),
  body('targeting')
    .optional()
    .isObject()
    .withMessage('Targeting must be an object'),
  body('experiment')
    .optional()
    .isObject()
    .withMessage('Experiment must be an object')
];

export const validateGetNotifications = [
  param('userId')
    .notEmpty()
    .isLength({ max: 50 })
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Valid userId is required'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .toInt()
    .withMessage('Limit must be between 1 and 100'),
  query('skip')
    .optional()
    .isInt({ min: 0 })
    .toInt()
    .withMessage('Skip must be non-negative'),
  query('type')
    .optional()
    .isIn([
      'general', 'security', 'marketing', 'system', 'urgent', 'promotional', 'reminder', 'social',
      'payment', 'order', 'message', 'alert', 'like', 'comment', 'follow', 'connection_request',
      'job_alert', 'mention', 'share', 'endorsement', 'profile_view', 'birthday', 'work_anniversary',
      'group_invite', 'event_invite', 'content_update'
    ])
    .withMessage('Invalid notification type'),
  query('seen')
    .optional()
    .isBoolean()
    .toBoolean()
    .withMessage('Seen must be a boolean'),
  query('priority')
    .optional()
    .isIn(['critical', 'high', 'medium', 'low'])
    .withMessage('Invalid priority level'),
  query('startDate')
    .optional()
    .isISO8601()
    .toDate()
    .withMessage('Invalid start date format'),
  query('endDate')
    .optional()
    .isISO8601()
    .toDate()
    .withMessage('Invalid end date format')
];

export const validateRegisterMobile = [
  body('userId')
    .notEmpty()
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Valid userId is required'),
  body('platform')
    .isIn(['ios', 'android', 'web'])
    .withMessage('Valid platform required'),
  body('token')
    .notEmpty()
    .isLength({ min: 10, max: 4096 })
    .withMessage('Valid token required'),
  body('deviceInfo')
    .optional()
    .isObject()
    .withMessage('Device info must be an object'),
  body('deviceInfo.appVersion')
    .optional()
    .isString()
    .isLength({ max: 20 })
    .withMessage('Invalid appVersion'),
  body('deviceInfo.locale')
    .optional()
    .custom(value => !value || validator.isLocale(value))
    .withMessage('Invalid locale'),
  body('provider')
    .optional()
    .isObject()
    .withMessage('Provider must be an object'),
  body('provider.service')
    .optional()
    .isIn(['fcm', 'apns', 'web-push'])
    .withMessage('Invalid provider service'),
  body('provider.bundleId')
    .optional()
    .isString()
    .isLength({ max: 100 })
    .withMessage('Invalid bundleId'),
  body('provider.senderId')
    .optional()
    .isString()
    .isLength({ max: 100 })
    .withMessage('Invalid senderId')
];

// Enhanced error handler with better logging and security
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const correlationId = req.correlationId || generateCorrelationId();
    
    // Log validation errors (but not in test environment)
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`Validation error [${correlationId}]:`, {
        path: req.path,
        method: req.method,
        userId: req.body?.userId || req.params?.userId,
        errors: errors.array()
      });
    }
    
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array().map(err => ({
        field: err.path || err.param,
        message: err.msg,
        value: err.value
      })),
      correlationId
    });
  }
  next();
};

// Enhanced async handler with better error handling
const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(error => {
    const correlationId = req.correlationId || generateCorrelationId();
    
    // Enhanced error logging
    console.error(`Request error [${correlationId}]:`, {
      path: req.path,
      method: req.method,
      userId: req.body?.userId || req.params?.userId,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });

    // Different error responses based on error type
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: 'Data validation failed',
        details: Object.values(error.errors).map(err => err.message),
        correlationId
      });
    }

    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        error: 'Invalid data format',
        correlationId
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Duplicate entry',
        correlationId
      });
    }

    // Generic server error
    res.status(500).json({
      success: false,
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      correlationId
    });
  });
};

const generateCorrelationId = () => {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').substring(0, 16);
};

const getBrowserFromUserAgent = userAgent => {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (ua.includes('chrome')) return 'chrome';
  if (ua.includes('firefox')) return 'firefox';
  if (ua.includes('safari')) return 'safari';
  if (ua.includes('edge')) return 'edge';
  if (ua.includes('opera')) return 'opera';
  return 'unknown';
};

const getOSFromUserAgent = userAgent => {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  if (ua.includes('android')) return 'android';
  if (ua.includes('ios')) return 'ios';
  return 'unknown';
};

// Helper function to get or create user safely
const getOrCreateUser = async (userId, defaultEmail = null) => {
  try {
    let user = await NotificationUser.findOne({ userId, 'deletion.isDeleted': false });
    
    if (!user) {
      const userData = {
        userId,
        contact: {
          email: defaultEmail && validator.isEmail(defaultEmail) ? defaultEmail : undefined,
          emailVerified: false
        },
        notificationPreferences: [
          { type: 'general', channels: ['in-app'], enabled: true },
          { type: 'security', channels: ['email', 'in-app'], enabled: true }
        ],
        status: {
          isActive: true,
          createdAt: new Date()
        }
      };

      // Only add email if it's valid
      if (defaultEmail && validator.isEmail(defaultEmail)) {
        userData.contact.email = defaultEmail;
      }

      user = new NotificationUser(userData);
      await user.save();
    }
    
    return user;
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate key error - try to find existing user
      return await NotificationUser.findOne({ userId, 'deletion.isDeleted': false });
    }
    throw error;
  }
};

// Helper function for safe Redis operations
const safeRedisGet = async (key) => {
  try {
    return await redis.get(key);
  } catch (error) {
    console.warn('Redis GET error:', error.message);
    return null;
  }
};

const safeRedisSet = async (key, value, ttl = 300) => {
  try {
    await redis.setex(key, ttl, value);
  } catch (error) {
    console.warn('Redis SET error:', error.message);
  }
};

// Controller Endpoints
export const sendNotification = [
  sendNotificationLimiter,
  ...validateSendNotification,
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const correlationId = generateCorrelationId();
    req.correlationId = correlationId;

    const {
      userId,
      channels,
      title,
      body,
      type = 'general',
      priority = 'medium',
      urgency = 'normal',
      data = {},
      scheduledFor,
      richContent,
      targeting,
      experiment
    } = req.body;

    // Get or create user safely
    const user = await getOrCreateUser(userId);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found and could not be created', 
        correlationId 
      });
    }

    // Check marketing consent
    if (type === 'marketing' && !user.consents.find(c => c.type === 'marketing' && c.given)) {
      return res.status(403).json({ 
        success: false, 
        error: 'User has not consented to marketing notifications', 
        correlationId 
      });
    }

    // Check user preferences
    if (!channels.some(channel => user.canReceiveNotification(type, channel, priority))) {
      return res.status(403).json({ 
        success: false, 
        error: 'User preferences do not allow this notification', 
        correlationId 
      });
    }

    // Check rate limits
    const rateLimitCheck = user.checkRateLimit();
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({ 
        success: false, 
        error: 'Rate limit exceeded', 
        reason: rateLimitCheck.reason, 
        correlationId 
      });
    }

    // Get device tokens if needed
    const deviceTokens = channels.some(ch => ['push', 'mobile'].includes(ch))
      ? await DeviceToken.findActiveByUser(userId, channels.includes('push') ? 'web' : 'mobile')
      : [];
      
    if (['push', 'mobile'].some(ch => channels.includes(ch)) && deviceTokens.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No active device tokens found for push/mobile channels', 
        correlationId 
      });
    }

    // Create notification data
    const notificationData = {
      userId,
      channels,
      title,
      body,
      type,
      priority,
      urgency,
      richContent,
      data: {
        ...data,
        source: data.source || 'api',
        correlationId,
        timestamp: new Date(),
        userAgent: req.get('User-Agent') || 'unknown',
        ipAddress: req.ip || 'unknown'
      },
      targeting,
      experiment,
      scheduling: scheduledFor ? { scheduledFor: new Date(scheduledFor) } : undefined,
      status: scheduledFor ? 'queued' : 'pending'
    };

    const notification = await Notification.create(notificationData);

    // Process notification if not scheduled
    if (!scheduledFor) {
      try {
        await user.incrementRateLimit();
        await user.recordNotificationReceived(channels[0]);

        const sendResult = await notificationService.processNotification(notification);
        
        if (sendResult.success) {
          notification.status = 'sent';
          notification.processing.completedAt = new Date();
          
          // Update delivery statuses
          for (const channel of channels) {
            if (sendResult.results[channel]) {
              notification.updateDeliveryStatus(
                channel, 
                sendResult.results[channel].status, 
                sendResult.results[channel].metadata
              );
              
              // Update device token stats
              if (['push', 'mobile'].includes(channel) && sendResult.results[channel].status === 'sent') {
                for (const token of deviceTokens) {
                  await token.recordNotificationSent(type);
                  if (sendResult.results[channel].status === 'delivered') {
                    await token.recordNotificationDelivered(type);
                  } else if (sendResult.results[channel].status === 'failed') {
                    await token.recordNotificationFailed(type, sendResult.results[channel].metadata?.error);
                  }
                }
              }
            }
          }

          // Emit WebSocket event if in-app channel is enabled
          const io = req.app.get('io');
          if (io && channels.includes('in-app') && 
              user.notificationPreferences.find(p => p.type === type && p.channels.includes('in-app'))) {
            io.to(userId).emit('notification', {
              id: notification._id,
              notificationId: notification.notificationId,
              userId,
              title,
              body,
              type,
              priority,
              channels,
              data: notification.data,
              createdAt: notification.createdAt,
              actions: notification.data.actions
            });
          }
        } else {
          notification.status = 'failed';
          notification.processing.lastError = {
            message: sendResult.error,
            timestamp: new Date(),
            code: sendResult.errorCode || 'SEND_FAILED'
          };
          
          if (notification.retry.count < notification.retry.maxRetries) {
            notification.incrementRetry();
          }
          
          // Record failures on device tokens
          if (['push', 'mobile'].some(ch => channels.includes(ch))) {
            for (const token of deviceTokens) {
              await token.recordNotificationFailed(type, sendResult.error);
            }
          }
        }

        await notification.save();
      } catch (error) {
        console.error('Failed to send notification:', error);
        notification.status = 'failed';
        notification.processing.lastError = { 
          message: error.message, 
          timestamp: new Date(), 
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined 
        };
        await notification.save();
        
        // Record failures on device tokens
        if (['push', 'mobile'].some(ch => channels.includes(ch))) {
          for (const token of deviceTokens) {
            await token.recordNotificationFailed(type, error.message);
          }
        }
      }
    }

    res.status(201).json({
      success: true,
      notification: {
        id: notification._id,
        notificationId: notification.notificationId,
        userId: notification.userId,
        title: notification.title,
        type: notification.type,
        priority: notification.priority,
        status: notification.status,
        channels: notification.channels,
        scheduledFor: notification.scheduling?.scheduledFor,
        createdAt: notification.createdAt,
        correlationId
      },
      correlationId
    });
  })
];

export const getUserNotifications = [
  getUserNotificationsLimiter,
  ...validateGetNotifications,
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const {
      type,
      subType,
      seen,
      priority,
      status,
      limit = 50,
      skip = 0,
      startDate,
      endDate,
      campaignId,
      batchId,
      unreadOnly = false,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Create cache key
    const cacheKey = `notifications:${userId}:${createHash('md5').update(JSON.stringify(req.query)).digest('hex')}`;
    const cached = await safeRedisGet(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const filters = {
      type,
      subType,
      status,
      startDate,
      endDate,
      limit: Math.min(parseInt(limit), 100),
      skip: parseInt(skip),
      sortBy,
      sortOrder: sortOrder === 'asc' ? 1 : -1
    };

    let notifications;
    let totalCount = 0;
    
    if (unreadOnly === 'true') {
      notifications = await Notification.findUnreadByUser(userId, { 
        limit: filters.limit, 
        skip: filters.skip, 
        type 
      }).lean();
      totalCount = await Notification.getUnreadCount(userId, type);
    } else {
      const query = { userId, 'deletion.isDeleted': false };
      
      // Apply filters
      if (type) query.type = type;
      if (subType) query.subType = subType;
      if (seen !== undefined) query['interactions.seen'] = seen === true;
      if (priority) query.priority = priority;
      if (status) query.status = status;
      if (campaignId) query['data.campaignId'] = campaignId;
      if (batchId) query['data.batchId'] = batchId;
      
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = startDate;
        if (endDate) query.createdAt.$lte = endDate;
      }

      notifications = await Notification.find(query)
        .sort({ [sortBy]: filters.sortOrder })
        .limit(filters.limit)
        .skip(filters.skip)
        .lean();
        
      totalCount = await Notification.countDocuments(query);
    }

    // Update user's last seen time
    if (notifications.length > 0) {
      try {
        const user = await NotificationUser.findOne({ userId, 'deletion.isDeleted': false });
        if (user) {
          user.status.lastSeenAt = new Date();
          await user.save();
        }
      } catch (error) {
        console.warn('Failed to update user last seen time:', error.message);
      }
    }

    const hasMore = totalCount > parseInt(skip) + parseInt(limit);
    const totalPages = Math.ceil(totalCount / parseInt(limit));
    const currentPage = Math.floor(parseInt(skip) / parseInt(limit)) + 1;

    const response = {
      success: true,
      notifications,
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        skip: parseInt(skip),
        currentPage,
        totalPages,
        hasMore,
        hasPrevious: parseInt(skip) > 0
      },
      filters: { type, subType, seen, priority, status, unreadOnly: unreadOnly === 'true' }
    };

    // Cache the response
    await safeRedisSet(cacheKey, JSON.stringify(response), 300);
    res.json(response);
  })
];

// Continue with other endpoints...
export const subscribePush = [
  body('userId')
    .notEmpty()
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Valid userId is required'),
  body('subscription')
    .isObject()
    .withMessage('Subscription object required'),
  body('subscription.endpoint')
    .matches(/^https?:\/\/[^\s/$.?#].[^\s]*$/)
    .withMessage('Valid endpoint URL required'),
  body('subscription.keys')
    .isObject()
    .withMessage('Keys object required'),
  body('subscription.keys.p256dh')
    .notEmpty()
    .withMessage('p256dh key required'),
  body('subscription.keys.auth')
    .notEmpty()
    .withMessage('auth key required'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, subscription } = req.body;
    const correlationId = generateCorrelationId();
    
    const metadata = {
      userAgent: req.get('User-Agent') || '',
      browser: getBrowserFromUserAgent(req.get('User-Agent')),
      os: getOSFromUserAgent(req.get('User-Agent')),
      ipAddress: req.ip || 'unknown'
    };

    // Get or create user safely (no email required for push subscriptions)
    const user = await getOrCreateUser(userId);
    if (!user) {
      return res.status(400).json({ 
        success: false, 
        error: 'Could not create or find user', 
        correlationId 
      });
    }

    // Check for existing token
    const existingToken = await DeviceToken.findByToken(subscription.endpoint, 'web');
    if (existingToken && existingToken.userId !== userId) {
      return res.status(409).json({ 
        success: false, 
        error: 'Push subscription already registered to another user', 
        correlationId 
      });
    }

    const tokenData = {
      userId,
      platform: 'web',
      token: subscription.endpoint,
      provider: {
        service: 'web-push',
        endpoint: subscription.endpoint,
        keys: subscription.keys
      },
      security: {
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent') || 'unknown',
        registrationSource: 'api'
      },
      deviceInfo: {
        browser: metadata.browser,
        os: metadata.os
      }
    };

    let deviceToken;
    if (existingToken) {
      await existingToken.refreshToken(subscription.endpoint, { 
        security: tokenData.security, 
        deviceInfo: tokenData.deviceInfo 
      });
      deviceToken = existingToken;
    } else {
      deviceToken = await DeviceToken.create(tokenData);
    }

    await user.addPushSubscription(subscription, metadata);
    
    // Validate token (non-blocking)
    try {
      await deviceToken.validateToken(pushService);
    } catch (error) {
      console.warn('Push subscription validation failed:', error.message);
    }

    res.json({ 
      success: true, 
      message: 'Push subscription added successfully', 
      userId, 
      tokenId: deviceToken.tokenId, 
      correlationId 
    });
  })
];

export const registerMobile = [
  ...validateRegisterMobile,
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, platform, token, deviceInfo = {}, provider = {} } = req.body;
    const correlationId = generateCorrelationId();
    
    const user = await getOrCreateUser(userId);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found and could not be created', 
        correlationId 
      });
    }

    const existingToken = await DeviceToken.findByToken(token, platform);
    if (existingToken && existingToken.userId !== userId) {
      return res.status(409).json({ 
        success: false, 
        error: 'Device token already registered to another user', 
        correlationId 
      });
    }

    const tokenData = {
      userId,
      platform,
      token,
      deviceInfo: {
        ...deviceInfo,
        timezone: deviceInfo.timezone || 'UTC',
        locale: deviceInfo.locale || 'en-US'
      },
      provider: {
        service: platform === 'ios' ? 'apns' : 'fcm',
        bundleId: provider.bundleId,
        senderId: provider.senderId
      },
      security: {
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent') || 'unknown',
        registrationSource: 'api'
      },
      status: 'active'
    };

    let deviceToken;
    if (existingToken) {
      await existingToken.refreshToken(token, { 
        deviceInfo: tokenData.deviceInfo, 
        security: tokenData.security 
      });
      deviceToken = existingToken;
    } else {
      deviceToken = await DeviceToken.create(tokenData);
    }

    // Validate token (non-blocking)
    try {
      await deviceToken.validateToken(pushService);
    } catch (error) {
      console.warn('Device token validation failed:', error.message);
    }

    res.json({ 
      success: true, 
      message: 'Device token registered successfully', 
      userId, 
      tokenId: deviceToken.tokenId, 
      correlationId 
    });
  })
];

// Health check endpoint
export const healthCheck = [
  asyncHandler(async (req, res) => {
    try {
      const correlationId = generateCorrelationId();
      
      // Basic database connectivity check
      const stats = await Notification.aggregate([
        { $match: { 'deletion.isDeleted': false } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);

      const pendingCount = await Notification.countDocuments({ 
        status: { $in: ['pending', 'queued'] }, 
        'deletion.isDeleted': false 
      });
      
      const failedCount = await Notification.countDocuments({ 
        status: 'failed', 
        'retry.count': { $lt: 3 }, 
        'deletion.isDeleted': false 
      });

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentNotifications = await Notification.countDocuments({ 
        createdAt: { $gte: oneHourAgo } 
      });
      
      const recentFailed = await Notification.countDocuments({ 
        createdAt: { $gte: oneHourAgo }, 
        status: 'failed' 
      });
      
      const errorRate = recentNotifications > 0 ? (recentFailed / recentNotifications) * 100 : 0;

      const activeUsers = await NotificationUser.countDocuments({
        'status.isActive': true,
        'status.lastSeenAt': { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        'deletion.isDeleted': false
      });

      const deviceStats = await DeviceToken.aggregate([
        { $match: { 'deletion.isDeleted': false } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);

      // Check Redis connectivity
      let redisStatus = 'unknown';
      try {
        await redis.ping();
        redisStatus = 'healthy';
      } catch (error) {
        redisStatus = 'unhealthy';
        console.warn('Redis health check failed:', error.message);
      }

      const healthStatus = {
        status: errorRate < 5 ? 'healthy' : errorRate < 20 ? 'warning' : 'critical',
        timestamp: new Date(),
        metrics: {
          notifications: {
            byStatus: stats.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {}),
            pending: pendingCount,
            needingRetry: failedCount,
            errorRate: Math.round(errorRate * 100) / 100
          },
          users: { active: activeUsers },
          deviceTokens: deviceStats.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {}),
          system: { 
            uptime: process.uptime(), 
            memory: process.memoryUsage(), 
            version: process.version,
            redis: redisStatus
          }
        }
      };

      res.json({ 
        success: true, 
        health: healthStatus, 
        correlationId 
      });
      
    } catch (error) {
      const correlationId = generateCorrelationId();
      console.error('Health check failed:', error);
      
      res.status(500).json({ 
        success: false, 
        health: { 
          status: 'critical', 
          timestamp: new Date(), 
          error: process.env.NODE_ENV === 'development' ? error.message : 'Health check failed' 
        }, 
        correlationId 
      });
    }
  })
];

// Additional endpoints for production-ready functionality
export const getNotificationById = [
  param('id').isMongoId().withMessage('Valid notification ID required'),
  query('userId').optional().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { userId } = req.query;
    const correlationId = generateCorrelationId();
    
    const query = { _id: id, 'deletion.isDeleted': false };
    if (userId) query.userId = userId;

    const notification = await Notification.findOne(query).lean();
    if (!notification) {
      return res.status(404).json({ 
        success: false, 
        error: 'Notification not found', 
        correlationId 
      });
    }

    // Mark as seen if user is viewing their own notification
    if (userId && userId === notification.userId && !notification.interactions.seen) {
      try {
        await Notification.findById(id).then(n => n?.markAsSeen());
        
        const user = await NotificationUser.findOne({ userId });
        if (user) {
          await user.recordNotificationEngagement('seen', 'in-app');
          
          // Emit WebSocket event
          const io = req.app.get('io');
          if (io && user.notificationPreferences.find(p => p.type === notification.type && p.channels.includes('in-app'))) {
            io.to(userId).emit('notification_seen', { id: notification._id, userId });
          }
        }
      } catch (error) {
        console.warn('Failed to mark notification as seen:', error.message);
      }
    }

    res.json({
      success: true,
      notification: {
        ...notification,
        isExpired: notification.expiresAt && notification.expiresAt < new Date(),
        overallStatus: notification.deletion.isDeleted ? 'deleted' : 
                      (notification.expiresAt && notification.expiresAt < new Date()) ? 'expired' : 
                      notification.status,
        deliverySuccess: notification.channels.some(ch => notification.delivery?.[ch]?.status === 'delivered')
      },
      correlationId
    });
  })
];

export const markNotificationRead = [
  param('id').isMongoId().withMessage('Valid notification ID required'),
  body('userId').optional().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('source').optional().isIn(['manual', 'auto', 'api']).withMessage('Invalid source'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { userId, source = 'manual' } = req.body;
    const correlationId = generateCorrelationId();
    
    const query = { _id: id, 'deletion.isDeleted': false };
    if (userId) query.userId = userId;

    const notification = await Notification.findOne(query);
    if (!notification) {
      return res.status(404).json({ 
        success: false, 
        error: 'Notification not found', 
        correlationId 
      });
    }

    await notification.markAsSeen();
    
    if (notification.userId) {
      try {
        const user = await NotificationUser.findOne({ userId: notification.userId });
        if (user) {
          await user.recordNotificationEngagement('seen', 'in-app');
          
          // Emit WebSocket event
          const io = req.app.get('io');
          if (io && user.notificationPreferences.find(p => p.type === notification.type && p.channels.includes('in-app'))) {
            io.to(notification.userId).emit('notification_seen', { 
              id: notification._id, 
              userId: notification.userId 
            });
          }
        }
      } catch (error) {
        console.warn('Failed to record engagement:', error.message);
      }
    }

    res.json({
      success: true,
      notification: {
        id: notification._id,
        notificationId: notification.notificationId,
        seen: notification.interactions.seen,
        seenAt: notification.interactions.seenAt,
        seenCount: notification.interactions.seenCount
      },
      correlationId
    });
  })
];

export const bulkMarkAsRead = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('notificationIds').isArray({ min: 1, max: 100 }).withMessage('1-100 notification IDs required'),
  body('notificationIds.*').isMongoId().withMessage('All notification IDs must be valid'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, notificationIds } = req.body;
    const correlationId = generateCorrelationId();
    
    // Validate notifications belong to user
    const validNotifications = await Notification.find({
      _id: { $in: notificationIds },
      userId,
      'deletion.isDeleted': false
    }).select('_id');
    
    const validIds = validNotifications.map(n => n._id.toString());
    const invalidIds = notificationIds.filter(id => !validIds.includes(id));
    
    if (invalidIds.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Some notification IDs are invalid or do not belong to the user', 
        invalidIds, 
        correlationId 
      });
    }

    const result = await Notification.bulkMarkAsSeen(userId, notificationIds);
    
    if (result.modifiedCount > 0) {
      try {
        const user = await NotificationUser.findOne({ userId });
        if (user) {
          user.analytics.totalNotificationsSeen += result.modifiedCount;
          user.calculateEngagementScore();
          await user.save();
          
          // Emit WebSocket event
          const io = req.app.get('io');
          if (io && user.notificationPreferences.some(p => p.channels.includes('in-app'))) {
            io.to(userId).emit('notifications_bulk_seen', { userId, notificationIds });
          }
        }
      } catch (error) {
        console.warn('Failed to update user analytics:', error.message);
      }
    }

    res.json({
      success: true,
      result: {
        requested: notificationIds.length,
        processed: result.matchedCount,
        updated: result.modifiedCount
      },
      correlationId
    });
  })
];

export const deleteNotification = [
  param('id').isMongoId().withMessage('Valid notification ID required'),
  body('userId').optional().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('reason').optional().isIn(['user_request', 'gdpr', 'admin', 'automated']).withMessage('Invalid deletion reason'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { userId, reason = 'user_request' } = req.body;
    const correlationId = generateCorrelationId();
    
    const query = { _id: id, 'deletion.isDeleted': false };
    if (userId) query.userId = userId;

    const notification = await Notification.findOne(query);
    if (!notification) {
      return res.status(404).json({ 
        success: false, 
        error: 'Notification not found', 
        correlationId 
      });
    }

    await notification.softDelete(reason, userId, { ipAddress: req.ip });
    
    // Emit WebSocket event
    try {
      const io = req.app.get('io');
      if (io && userId) {
        const user = await NotificationUser.findOne({ userId });
        if (user && user.notificationPreferences.some(p => p.channels.includes('in-app'))) {
          io.to(userId).emit('notification_deleted', { id: notification._id, userId });
        }
      }
    } catch (error) {
      console.warn('Failed to emit WebSocket event:', error.message);
    }

    res.json({
      success: true,
      message: 'Notification deleted successfully',
      deletedAt: notification.deletion.deletedAt,
      correlationId
    });
  })
];

export const updateUserPreferences = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId is required'),
  body('notificationPreferences').isArray().withMessage('Notification preferences must be an array'),
  body('notificationPreferences.*.type').isIn([
    'general', 'security', 'marketing', 'system', 'urgent', 'promotional', 'reminder', 'social',
    'payment', 'order', 'message', 'alert', 'like', 'comment', 'follow', 'connection_request',
    'job_alert', 'mention', 'share', 'endorsement', 'profile_view', 'birthday', 'work_anniversary',
    'group_invite', 'event_invite', 'content_update'
  ]).withMessage('Invalid notification type'),
  body('notificationPreferences.*.channels').isArray({ min: 1 }).withMessage('At least one channel required'),
  body('notificationPreferences.*.channels.*').isIn(['email', 'push', 'sms', 'mobile', 'in-app', 'slack', 'teams']).withMessage('Invalid channel'),
  body('notificationPreferences.*.enabled').optional().isBoolean().withMessage('Enabled must be boolean'),
  body('notificationPreferences.*.frequency').optional().isIn(['immediate', 'hourly', 'daily', 'weekly', 'never']).withMessage('Invalid frequency'),
  body('notificationPreferences.*.priority').optional().isIn(['critical', 'high', 'medium', 'low']).withMessage('Invalid priority'),
  body('quietHours').optional().isObject().withMessage('Quiet hours must be an object'),
  body('quietHours.enabled').optional().isBoolean().withMessage('Quiet hours enabled must be boolean'),
  body('quietHours.startTime').optional().matches(/^\d{2}:\d{2}$/).withMessage('Invalid start time format (HH:MM)'),
  body('quietHours.endTime').optional().matches(/^\d{2}:\d{2}$/).withMessage('Invalid end time format (HH:MM)'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, notificationPreferences, quietHours } = req.body;
    const correlationId = generateCorrelationId();
    
    const user = await getOrCreateUser(userId);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found and could not be created', 
        correlationId 
      });
    }

    // Update notification preferences
    for (const pref of notificationPreferences) {
      await user.updateNotificationPreference(
        pref.type,
        pref.channels,
        pref.enabled !== undefined ? pref.enabled : true,
        pref.frequency || 'immediate',
        pref.priority || 'medium',
        { ipAddress: req.ip, userAgent: req.get('User-Agent') }
      );
    }

    // Update quiet hours if provided
    if (quietHours) {
      user.quietHours = { ...user.quietHours, ...quietHours };
      user.compliance.auditLog.push({
        action: 'quiet_hours_updated',
        field: 'quietHours',
        newValue: quietHours,
        timestamp: new Date(),
        ipAddress: req.ip
      });
      await user.save();
    }

    res.json({
      success: true,
      message: 'Preferences updated successfully',
      notificationPreferences: user.notificationPreferences,
      quietHours: user.quietHours,
      correlationId
    });
  })
];

// Add after existing endpoints, before gracefulShutdown

// Get notification templates
export const getNotificationTemplates = [
  query('type')
    .optional()
    .isIn([
      'general', 'security', 'marketing', 'system', 'urgent', 'promotional', 'reminder', 'social',
      'payment', 'order', 'message', 'alert', 'like', 'comment', 'follow', 'connection_request',
      'job_alert', 'mention', 'share', 'endorsement', 'profile_view', 'birthday', 'work_anniversary',
      'group_invite', 'event_invite', 'content_update',
    ])
    .withMessage('Invalid notification type'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .toInt()
    .withMessage('Limit must be between 1 and 100'),
  query('skip')
    .optional()
    .isInt({ min: 0 })
    .toInt()
    .withMessage('Skip must be non-negative'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const correlationId = generateCorrelationId();
    const { type, limit = 50, skip = 0 } = req.query;

    try {
      const query = { isTemplate: true, 'deletion.isDeleted': false };
      if (type) query.type = type;

      const templates = await Notification.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean();

      const totalCount = await Notification.countDocuments(query);
      const hasMore = totalCount > skip + limit;
      const totalPages = Math.ceil(totalCount / limit);
      const currentPage = Math.floor(skip / limit) + 1;

      const cacheKey = `notification_templates:${createHash('md5').update(JSON.stringify(req.query)).digest('hex')}`;
      const response = {
        success: true,
        templates,
        pagination: {
          total: totalCount,
          limit,
          skip,
          currentPage,
          totalPages,
          hasMore,
          hasPrevious: skip > 0,
        },
        correlationId,
      };

      await safeRedisSet(cacheKey, JSON.stringify(response), 300);
      res.json(response);
    } catch (error) {
      console.error(`Error fetching notification templates [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch notification templates',
        correlationId,
      });
    }
  }),
];

// Get scheduled notifications
export const getScheduledNotifications = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .toInt()
    .withMessage('Limit must be between 1 and 100'),
  query('skip')
    .optional()
    .isInt({ min: 0 })
    .toInt()
    .withMessage('Skip must be non-negative'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const correlationId = generateCorrelationId();
    const { limit = 50, skip = 0 } = req.query;

    try {
      const notifications = await Notification.find({
        status: 'queued',
        'scheduling.scheduledFor': { $exists: true },
        'deletion.isDeleted': false,
      })
        .sort({ 'scheduling.scheduledFor': 1 })
        .limit(limit)
        .skip(skip)
        .lean();

      const totalCount = await Notification.countDocuments({
        status: 'queued',
        'scheduling.scheduledFor': { $exists: true },
        'deletion.isDeleted': false,
      });

      const hasMore = totalCount > skip + limit;
      const totalPages = Math.ceil(totalCount / limit);
      const currentPage = Math.floor(skip / limit) + 1;

      const cacheKey = `scheduled_notifications:${createHash('md5').update(JSON.stringify(req.query)).digest('hex')}`;
      const response = {
        success: true,
        notifications,
        pagination: {
          total: totalCount,
          limit,
          skip,
          currentPage,
          totalPages,
          hasMore,
          hasPrevious: skip > 0,
        },
        correlationId,
      };

      await safeRedisSet(cacheKey, JSON.stringify(response), 300);
      res.json(response);
    } catch (error) {
      console.error(`Error fetching scheduled notifications [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch scheduled notifications',
        correlationId,
      });
    }
  }),
];

// Get failed notifications
export const getFailedNotifications = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .toInt()
    .withMessage('Limit must be between 1 and 100'),
  query('skip')
    .optional()
    .isInt({ min: 0 })
    .toInt()
    .withMessage('Skip must be non-negative'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const correlationId = generateCorrelationId();
    const { limit = 50, skip = 0 } = req.query;

    try {
      const notifications = await Notification.find({
        status: 'failed',
        'deletion.isDeleted': false,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean();

      const totalCount = await Notification.countDocuments({
        status: 'failed',
        'deletion.isDeleted': false,
      });

      const hasMore = totalCount > skip + limit;
      const totalPages = Math.ceil(totalCount / limit);
      const currentPage = Math.floor(skip / limit) + 1;

      const cacheKey = `failed_notifications:${createHash('md5').update(JSON.stringify(req.query)).digest('hex')}`;
      const response = {
        success: true,
        notifications,
        pagination: {
          total: totalCount,
          limit,
          skip,
          currentPage,
          totalPages,
          hasMore,
          hasPrevious: skip > 0,
        },
        correlationId,
      };

      await safeRedisSet(cacheKey, JSON.stringify(response), 300);
      res.json(response);
    } catch (error) {
      console.error(`Error fetching failed notifications [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch failed notifications',
        correlationId,
      });
    }
  }),
];

// Cleanup expired tokens
export const cleanupExpiredTokens = [
  body('days')
    .optional()
    .isInt({ min: 1 })
    .toInt()
    .withMessage('Days must be a positive integer'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const correlationId = generateCorrelationId();
    const { days = 30 } = req.body;

    try {
      const expirationDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const result = await DeviceToken.deleteMany({
        'status.lastActivityAt': { $lt: expirationDate },
        'deletion.isDeleted': false,
      });

      res.json({
        success: true,
        message: 'Expired tokens cleaned up successfully',
        deletedCount: result.deletedCount,
        correlationId,
      });
    } catch (error) {
      console.error(`Error cleaning up expired tokens [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to clean up expired tokens',
        correlationId,
      });
    }
  }),
];

// Bulk delete notifications
export const bulkDeleteNotifications = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('notificationIds').isArray({ min: 1, max: 100 }).withMessage('1-100 notification IDs required'),
  body('notificationIds.*').isMongoId().withMessage('All notification IDs must be valid'),
  body('reason').optional().isIn(['user_request', 'gdpr', 'admin', 'automated']).withMessage('Invalid deletion reason'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, notificationIds, reason = 'user_request' } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const validNotifications = await Notification.find({
        _id: { $in: notificationIds },
        userId,
        'deletion.isDeleted': false,
      }).select('_id');

      const validIds = validNotifications.map(n => n._id.toString());
      const invalidIds = notificationIds.filter(id => !validIds.includes(id));

      if (invalidIds.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Some notification IDs are invalid or do not belong to the user',
          invalidIds,
          correlationId,
        });
      }

      const result = await Notification.updateMany(
        { _id: { $in: notificationIds }, userId, 'deletion.isDeleted': false },
        {
          $set: {
            'deletion.isDeleted': true,
            'deletion.deletedAt': new Date(),
            'deletion.reason': reason,
            'deletion.by': userId,
          },
        }
      );

      if (result.modifiedCount > 0) {
        const io = req.app.get('io');
        if (io) {
          const user = await NotificationUser.findOne({ userId });
          if (user && user.notificationPreferences.some(p => p.channels.includes('in-app'))) {
            io.to(userId).emit('notifications_bulk_deleted', { userId, notificationIds });
          }
        }
      }

      res.json({
        success: true,
        result: {
          requested: notificationIds.length,
          processed: result.matchedCount,
          deleted: result.modifiedCount,
        },
        correlationId,
      });
    } catch (error) {
      console.error(`Error deleting notifications [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete notifications',
        correlationId,
      });
    }
  }),
];

// Deactivate device token
export const deactivateDeviceToken = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('token').notEmpty().isLength({ min: 10, max: 4096 }).withMessage('Valid token required'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, token } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const deviceToken = await DeviceToken.findOne({ userId, token, 'deletion.isDeleted': false });
      if (!deviceToken) {
        return res.status(404).json({
          success: false,
          error: 'Device token not found',
          correlationId,
        });
      }

      await deviceToken.deactivate();
      res.json({
        success: true,
        message: 'Device token deactivated successfully',
        tokenId: deviceToken.tokenId,
        correlationId,
      });
    } catch (error) {
      console.error(`Error deactivating device token [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to deactivate device token',
        correlationId,
      });
    }
  }),
];

// Refresh device token
export const refreshDeviceToken = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('oldToken').notEmpty().isLength({ min: 10, max: 4096 }).withMessage('Valid old token required'),
  body('newToken').notEmpty().isLength({ min: 10, max: 4096 }).withMessage('Valid new token required'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, oldToken, newToken } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const deviceToken = await DeviceToken.findOne({ userId, token: oldToken, 'deletion.isDeleted': false });
      if (!deviceToken) {
        return res.status(404).json({
          success: false,
          error: 'Device token not found',
          correlationId,
        });
      }

      await deviceToken.refreshToken(newToken, {
        security: { ipAddress: req.ip, userAgent: req.get('User-Agent') || 'unknown' },
      });

      res.json({
        success: true,
        message: 'Device token refreshed successfully',
        tokenId: deviceToken.tokenId,
        correlationId,
      });
    } catch (error) {
      console.error(`Error refreshing device token [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to refresh device token',
        correlationId,
      });
    }
  }),
];

// Validate device token
export const validateDeviceToken = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('token').notEmpty().isLength({ min: 10, max: 4096 }).withMessage('Valid token required'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, token } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const deviceToken = await DeviceToken.findOne({ userId, token, 'deletion.isDeleted': false });
      if (!deviceToken) {
        return res.status(404).json({
          success: false,
          error: 'Device token not found',
          correlationId,
        });
      }

      const isValid = await deviceToken.validateToken(pushService);
      res.json({
        success: true,
        isValid,
        tokenId: deviceToken.tokenId,
        correlationId,
      });
    } catch (error) {
      console.error(`Error validating device token [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to validate device token',
        correlationId,
      });
    }
  }),
];

// Set user email
export const setUserEmail = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('email').isEmail().withMessage('Valid email required'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, email } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const user = await getOrCreateUser(userId, email);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found and could not be created',
          correlationId,
        });
      }

      user.contact.email = email;
      user.contact.emailVerified = false;
      await user.save();

      res.json({
        success: true,
        message: 'Email updated successfully',
        email,
        correlationId,
      });
    } catch (error) {
      console.error(`Error setting user email [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to set user email',
        correlationId,
      });
    }
  }),
];

// Grant consent
export const grantConsent = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('type').isIn(['marketing', 'general', 'security']).withMessage('Invalid consent type'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, type } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const user = await getOrCreateUser(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found and could not be created',
          correlationId,
        });
      }

      await user.grantConsent(type, { ipAddress: req.ip, userAgent: req.get('User-Agent') || 'unknown' });
      await user.save();

      res.json({
        success: true,
        message: `Consent for ${type} granted successfully`,
        correlationId,
      });
    } catch (error) {
      console.error(`Error granting consent [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to grant consent',
        correlationId,
      });
    }
  }),
];

// Revoke consent
export const revokeConsent = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('type').isIn(['marketing', 'general', 'security']).withMessage('Invalid consent type'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, type } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const user = await getOrCreateUser(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found and could not be created',
          correlationId,
        });
      }

      await user.revokeConsent(type, { ipAddress: req.ip, userAgent: req.get('User-Agent') || 'unknown' });
      await user.save();

      res.json({
        success: true,
        message: `Consent for ${type} revoked successfully`,
        correlationId,
      });
    } catch (error) {
      console.error(`Error revoking consent [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to revoke consent',
        correlationId,
      });
    }
  }),
];

// Pause user notifications
export const pauseUserNotifications = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('duration').optional().isInt({ min: 1 }).toInt().withMessage('Duration must be a positive integer (minutes)'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, duration } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const user = await getOrCreateUser(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found and could not be created',
          correlationId,
        });
      }

      user.status.isPaused = true;
      user.status.pausedUntil = duration ? new Date(Date.now() + duration * 60 * 1000) : undefined;
      await user.save();

      res.json({
        success: true,
        message: 'Notifications paused successfully',
        pausedUntil: user.status.pausedUntil,
        correlationId,
      });
    } catch (error) {
      console.error(`Error pausing notifications [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to pause notifications',
        correlationId,
      });
    }
  }),
];

// Resume user notifications
export const resumeUserNotifications = [
  body('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const user = await getOrCreateUser(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found and could not be created',
          correlationId,
        });
      }

      user.status.isPaused = false;
      user.status.pausedUntil = null;
      await user.save();

      res.json({
        success: true,
        message: 'Notifications resumed successfully',
        correlationId,
      });
    } catch (error) {
      console.error(`Error resuming notifications [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to resume notifications',
        correlationId,
      });
    }
  }),
];

// Get notifications by type
export const getNotificationsByType = [
  param('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  param('type').isIn([
    'general', 'security', 'marketing', 'system', 'urgent', 'promotional', 'reminder', 'social',
    'payment', 'order', 'message', 'alert', 'like', 'comment', 'follow', 'connection_request',
    'job_alert', 'mention', 'share', 'endorsement', 'profile_view', 'birthday', 'work_anniversary',
    'group_invite', 'event_invite', 'content_update',
  ]).withMessage('Invalid notification type'),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('Limit must be between 1 and 100'),
  query('skip').optional().isInt({ min: 0 }).toInt().withMessage('Skip must be non-negative'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, type } = req.params;
    const { limit = 50, skip = 0 } = req.query;
    const correlationId = generateCorrelationId();

    try {
      const notifications = await Notification.find({
        userId,
        type,
        'deletion.isDeleted': false,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean();

      const totalCount = await Notification.countDocuments({
        userId,
        type,
        'deletion.isDeleted': false,
      });

      const hasMore = totalCount > skip + limit;
      const totalPages = Math.ceil(totalCount / limit);
      const currentPage = Math.floor(skip / limit) + 1;

      const cacheKey = `notifications_by_type:${userId}:${type}:${createHash('md5').update(JSON.stringify(req.query)).digest('hex')}`;
      const response = {
        success: true,
        notifications,
        pagination: {
          total: totalCount,
          limit,
          skip,
          currentPage,
          totalPages,
          hasMore,
          hasPrevious: skip > 0,
        },
        correlationId,
      };

      await safeRedisSet(cacheKey, JSON.stringify(response), 300);
      res.json(response);
    } catch (error) {
      console.error(`Error fetching notifications by type [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch notifications by type',
        correlationId,
      });
    }
  }),
];

// Get grouped notifications
export const getGroupedNotifications = [
  param('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  param('groupId').notEmpty().isString().withMessage('Valid groupId required'),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('Limit must be between 1 and 100'),
  query('skip').optional().isInt({ min: 0 }).toInt().withMessage('Skip must be non-negative'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId, groupId } = req.params;
    const { limit = 50, skip = 0 } = req.query;
    const correlationId = generateCorrelationId();

    try {
      const notifications = await Notification.find({
        userId,
        'data.groupId': groupId,
        'deletion.isDeleted': false,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean();

      const totalCount = await Notification.countDocuments({
        userId,
        'data.groupId': groupId,
        'deletion.isDeleted': false,
      });

      const hasMore = totalCount > skip + limit;
      const totalPages = Math.ceil(totalCount / limit);
      const currentPage = Math.floor(skip / limit) + 1;

      const cacheKey = `grouped_notifications:${userId}:${groupId}:${createHash('md5').update(JSON.stringify(req.query)).digest('hex')}`;
      const response = {
        success: true,
        notifications,
        pagination: {
          total: totalCount,
          limit,
          skip,
          currentPage,
          totalPages,
          hasMore,
          hasPrevious: skip > 0,
        },
        correlationId,
      };

      await safeRedisSet(cacheKey, JSON.stringify(response), 300);
      res.json(response);
    } catch (error) {
      console.error(`Error fetching grouped notifications [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch grouped notifications',
        correlationId,
      });
    }
  }),
];

// Get user analytics
export const getUserAnalytics = [
  param('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  query('startDate').optional().isISO8601().toDate().withMessage('Invalid start date format'),
  query('endDate').optional().isISO8601().toDate().withMessage('Invalid end date format'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { startDate, endDate } = req.query;
    const correlationId = generateCorrelationId();

    try {
      const user = await NotificationUser.findOne({ userId, 'deletion.isDeleted': false });
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found',
          correlationId,
        });
      }

      const query = { userId, 'deletion.isDeleted': false };
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = startDate;
        if (endDate) query.createdAt.$lte = endDate;
      }

      const analytics = await Notification.aggregate([
        { $match: query },
        {
          $group: {
            _id: '$type',
            totalSent: { $sum: 1 },
            totalSeen: { $sum: { $cond: ['$interactions.seen', 1, 0] } },
            totalClicked: { $sum: { $cond: ['$interactions.clicked', 1, 0] } },
          },
        },
      ]);

      res.json({
        success: true,
        analytics: {
          userId,
          engagementScore: user.analytics.engagementScore || 0,
          totalNotificationsSent: user.analytics.totalNotificationsSent || 0,
          totalNotificationsSeen: user.analytics.totalNotificationsSeen || 0,
          byType: analytics,
        },
        correlationId,
      });
    } catch (error) {
      console.error(`Error fetching user analytics [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch user analytics',
        correlationId,
      });
    }
  }),
];

// Search notifications
export const searchNotifications = [
  param('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  query('query').notEmpty().isString().withMessage('Search query required'),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('Limit must be between 1 and 100'),
  query('skip').optional().isInt({ min: 0 }).toInt().withMessage('Skip must be non-negative'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { query: searchQuery, limit = 50, skip = 0 } = req.query;
    const correlationId = generateCorrelationId();

    try {
      const notifications = await Notification.find({
        userId,
        'deletion.isDeleted': false,
        $or: [
          { title: { $regex: searchQuery, $options: 'i' } },
          { body: { $regex: searchQuery, $options: 'i' } },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean();

      const totalCount = await Notification.countDocuments({
        userId,
        'deletion.isDeleted': false,
        $or: [
          { title: { $regex: searchQuery, $options: 'i' } },
          { body: { $regex: searchQuery, $options: 'i' } },
        ],
      });

      const hasMore = totalCount > skip + limit;
      const totalPages = Math.ceil(totalCount / limit);
      const currentPage = Math.floor(skip / limit) + 1;

      const cacheKey = `search_notifications:${userId}:${createHash('md5').update(searchQuery + JSON.stringify(req.query)).digest('hex')}`;
      const response = {
        success: true,
        notifications,
        pagination: {
          total: totalCount,
          limit,
          skip,
          currentPage,
          totalPages,
          hasMore,
          hasPrevious: skip > 0,
        },
        correlationId,
      };

      await safeRedisSet(cacheKey, JSON.stringify(response), 300);
      res.json(response);
    } catch (error) {
      console.error(`Error searching notifications [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to search notifications',
        correlationId,
      });
    }
  }),
];

// Get device token analytics
export const getDeviceTokenAnalytics = [
  param('userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  query('startDate').optional().isISO8601().toDate().withMessage('Invalid start date format'),
  query('endDate').optional().isISO8601().toDate().withMessage('Invalid end date format'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { startDate, endDate } = req.query;
    const correlationId = generateCorrelationId();

    try {
      const query = { userId, 'deletion.isDeleted': false };
      if (startDate || endDate) {
        query['status.lastActivityAt'] = {};
        if (startDate) query['status.lastActivityAt'].$gte = startDate;
        if (endDate) query['status.lastActivityAt'].$lte = endDate;
      }

      const analytics = await DeviceToken.aggregate([
        { $match: query },
        {
          $group: {
            _id: '$platform',
            totalTokens: { $sum: 1 },
            activeTokens: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
            notificationsSent: { $sum: '$analytics.notificationsSent' },
            notificationsDelivered: { $sum: '$analytics.notificationsDelivered' },
            notificationsFailed: { $sum: '$analytics.notificationsFailed' },
          },
        },
      ]);

      res.json({
        success: true,
        analytics: {
          userId,
          byPlatform: analytics,
        },
        correlationId,
      });
    } catch (error) {
      console.error(`Error fetching device token analytics [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch device token analytics',
        correlationId,
      });
    }
  }),
];

// Retry notification
export const retryNotification = [
  param('id').isMongoId().withMessage('Valid notification ID required'),
  body('userId').optional().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const query = { _id: id, 'deletion.isDeleted': false, status: 'failed' };
      if (userId) query.userId = userId;

      const notification = await Notification.findOne(query);
      if (!notification) {
        return res.status(404).json({
          success: false,
          error: 'Notification not found or not eligible for retry',
          correlationId,
        });
      }

      if (notification.retry.count >= notification.retry.maxRetries) {
        return res.status(400).json({
          success: false,
          error: 'Maximum retry attempts reached',
          correlationId,
        });
      }

      notification.status = 'pending';
      notification.incrementRetry();
      await notification.save();

      const sendResult = await notificationService.processNotification(notification);
      if (sendResult.success) {
        notification.status = 'sent';
        notification.processing.completedAt = new Date();
        for (const channel of notification.channels) {
          if (sendResult.results[channel]) {
            notification.updateDeliveryStatus(
              channel,
              sendResult.results[channel].status,
              sendResult.results[channel].metadata
            );
          }
        }
      } else {
        notification.status = 'failed';
        notification.processing.lastError = {
          message: sendResult.error,
          timestamp: new Date(),
          code: sendResult.errorCode || 'SEND_FAILED',
        };
      }

      await notification.save();

      res.json({
        success: true,
        notification: {
          id: notification._id,
          notificationId: notification.notificationId,
          status: notification.status,
          retryCount: notification.retry.count,
        },
        correlationId,
      });
    } catch (error) {
      console.error(`Error retrying notification [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to retry notification',
        correlationId,
      });
    }
  }),
];

// Update delivery status
export const updateDeliveryStatus = [
  param('id').isMongoId().withMessage('Valid notification ID required'),
  body('channel').isIn(['email', 'push', 'sms', 'mobile', 'in-app', 'slack', 'teams']).withMessage('Invalid channel'),
  body('status').isIn(['sent', 'delivered', 'failed']).withMessage('Invalid status'),
  body('metadata').optional().isObject().withMessage('Metadata must be an object'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { channel, status, metadata = {} } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const notification = await Notification.findOne({ _id: id, 'deletion.isDeleted': false });
      if (!notification) {
        return res.status(404).json({
          success: false,
          error: 'Notification not found',
          correlationId,
        });
      }

      notification.updateDeliveryStatus(channel, status, metadata);
      await notification.save();

      if (status === 'delivered' && notification.userId) {
        const user = await NotificationUser.findOne({ userId: notification.userId });
        if (user) {
          await user.recordNotificationEngagement('delivered', channel);
          const io = req.app.get('io');
          if (io && user.notificationPreferences.find(p => p.type === notification.type && p.channels.includes('in-app'))) {
            io.to(notification.userId).emit('notification_delivered', { id: notification._id, userId: notification.userId, channel });
          }
        }
      }

      res.json({
        success: true,
        message: 'Delivery status updated successfully',
        notificationId: notification.notificationId,
        channel,
        status,
        correlationId,
      });
    } catch (error) {
      console.error(`Error updating delivery status [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to update delivery status',
        correlationId,
      });
    }
  }),
];

// Mark notification as clicked
export const markNotificationClicked = [
  param('id').isMongoId().withMessage('Valid notification ID required'),
  body('userId').optional().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('source').optional().isIn(['manual', 'auto', 'api']).withMessage('Invalid source'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { userId, source = 'manual' } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const query = { _id: id, 'deletion.isDeleted': false };
      if (userId) query.userId = userId;

      const notification = await Notification.findOne(query);
      if (!notification) {
        return res.status(404).json({
          success: false,
          error: 'Notification not found',
          correlationId,
        });
      }

      await notification.markAsClicked();
      await notification.save();

      if (notification.userId) {
        const user = await NotificationUser.findOne({ userId: notification.userId });
        if (user) {
          await user.recordNotificationEngagement('clicked', 'in-app');
          const io = req.app.get('io');
          if (io && user.notificationPreferences.find(p => p.type === notification.type && p.channels.includes('in-app'))) {
            io.to(notification.userId).emit('notification_clicked', { id: notification._id, userId: notification.userId });
          }
        }
      }

      res.json({
        success: true,
        notification: {
          id: notification._id,
          notificationId: notification.notificationId,
          clicked: notification.interactions.clicked,
          clickedAt: notification.interactions.clickedAt,
          clickedCount: notification.interactions.clickedCount,
        },
        correlationId,
      });
    } catch (error) {
      console.error(`Error marking notification as clicked [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to mark notification as clicked',
        correlationId,
      });
    }
  }),
];

// Dismiss notification
export const dismissNotification = [
  param('id').isMongoId().withMessage('Valid notification ID required'),
  body('userId').optional().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('reason').optional().isIn(['user_request', 'auto', 'api']).withMessage('Invalid dismissal reason'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { userId, reason = 'user_request' } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const query = { _id: id, 'deletion.isDeleted': false };
      if (userId) query.userId = userId;

      const notification = await Notification.findOne(query);
      if (!notification) {
        return res.status(404).json({
          success: false,
          error: 'Notification not found',
          correlationId,
        });
      }

      notification.status = 'dismissed';
      notification.interactions.dismissed = true;
      notification.interactions.dismissedAt = new Date();
      notification.interactions.dismissedCount = (notification.interactions.dismissedCount || 0) + 1;
      await notification.save();

      if (notification.userId) {
        const user = await NotificationUser.findOne({ userId: notification.userId });
        if (user) {
          await user.recordNotificationEngagement('dismissed', 'in-app');
          const io = req.app.get('io');
          if (io && user.notificationPreferences.find(p => p.type === notification.type && p.channels.includes('in-app'))) {
            io.to(notification.userId).emit('notification_dismissed', { id: notification._id, userId: notification.userId });
          }
        }
      }

      res.json({
        success: true,
        message: 'Notification dismissed successfully',
        notificationId: notification.notificationId,
        correlationId,
      });
    } catch (error) {
      console.error(`Error dismissing notification [${correlationId}]:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to dismiss notification',
        correlationId,
      });
    }
  }),
];


// Graceful shutdown handler
export const gracefulShutdown = () => {
  console.log('Initiating graceful shutdown...');
  
  return new Promise((resolve) => {
    // Close Redis connection
    if (redis) {
      redis.disconnect();
      console.log('Redis connection closed');
    }
    
    // Allow time for pending requests to complete
    setTimeout(() => {
      console.log('Graceful shutdown complete');
      resolve();
    }, 5000);
  });
};

// Export Redis instance for external use
export { redis };