import Notification from '../models/Notification.js';
import NotificationUser from '../models/User.js';
import DeviceToken from '../models/DeviceToken.js';
import notificationService from '../services/core/notificationService.js';
import { validationResult, body, header, query } from 'express-validator';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import Redis from 'ioredis';
import validator from 'validator';

// Initialize Redis client
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Event emitter for webhook events
export const webhookEvents = new EventEmitter();

// Rate limiter
const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  message: { success: false, error: 'Webhook rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.headers['x-api-key'] && isValidApiKey(req.headers['x-api-key'])
});

// Webhook signature verification
const verifyWebhookSignature = (req, res, next) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const payload = JSON.stringify(req.body);

  if (process.env.NODE_ENV === 'development' && !signature) {
    return next();
  }

  if (!signature || !timestamp) {
    return res.status(401).json({
      success: false,
      error: 'Missing webhook signature or timestamp',
      correlationId: generateWebhookId()
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const webhookTimestamp = parseInt(timestamp);
  if (Math.abs(now - webhookTimestamp) > 300) {
    return res.status(401).json({
      success: false,
      error: 'Webhook timestamp too old',
      correlationId: generateWebhookId()
    });
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET || 'default-secret')
    .update(timestamp + payload)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return res.status(401).json({
      success: false,
      error: 'Invalid webhook signature',
      correlationId: generateWebhookId()
    });
  }

  next();
};

// API key validation
const isValidApiKey = apiKey => {
  const validKeys = (process.env.VALID_API_KEYS || '').split(',');
  return validKeys.includes(apiKey);
};

// Webhook validation
export const validateWebhook = [
  body('event')
    .notEmpty()
    .isLength({ min: 1, max: 100 })
    .matches(/^[a-zA-Z0-9._-]+$/)
    .withMessage('Valid event name is required'),
  body('userId')
    .notEmpty()
    .isLength({ min: 1, max: 50 })
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Valid userId is required'),
  body('channels')
    .optional()
    .isArray({ min: 1, max: 5 })
    .custom(channels => channels.every(channel => ['email', 'push', 'sms', 'mobile', 'in-app', 'slack', 'teams'].includes(channel)))
    .withMessage('Invalid channel specified'),
  body('payload')
    .isObject()
    .custom(payload => JSON.stringify(payload).length <= 5120)
    .withMessage('Payload too large (max 5KB)'),
  body('metadata')
    .optional()
    .isObject()
    .custom(metadata => JSON.stringify(metadata).length <= 2048)
    .withMessage('Metadata too large (max 2KB)'),
  body('priority')
    .optional()
    .isIn(['critical', 'high', 'medium', 'low'])
    .withMessage('Invalid priority level'),
  body('scheduled_for')
    .optional()
    .isISO8601()
    .custom(value => new Date(value) > new Date())
    .withMessage('Scheduled time must be in the future'),
  body('groupId')
    .optional()
    .isString()
    .isLength({ max: 50 })
    .withMessage('Invalid groupId')
];

// Event mappings aligned with NotificationSchema
const EVENT_MAPPINGS = {
  'user.registered': { type: 'system', priority: 'medium', channels: ['email', 'push', 'in-app'], template: 'welcome' },
  'user.login': { type: 'security', priority: 'low', channels: ['email'], template: 'login_notification' },
  'user.password_changed': { type: 'security', priority: 'high', channels: ['email', 'sms'], template: 'password_changed' },
  'user.email_verified': { type: 'system', priority: 'medium', channels: ['push', 'in-app'], template: 'email_verified' },
  'social.like': { type: 'like', priority: 'low', channels: ['push', 'in-app'], template: 'like_notification' },
  'social.comment': { type: 'comment', priority: 'medium', channels: ['push', 'email', 'in-app'], template: 'comment_notification' },
  'social.follow': { type: 'follow', priority: 'medium', channels: ['push', 'in-app'], template: 'follow_notification' },
  'social.mention': { type: 'mention', priority: 'medium', channels: ['push', 'email', 'in-app'], template: 'mention_notification' },
  'payment.success': { type: 'payment', priority: 'high', channels: ['email', 'push'], template: 'payment_success' },
  'payment.failed': { type: 'payment', priority: 'high', channels: ['email', 'push'], template: 'payment_failed' },
  'payment.refunded': { type: 'payment', priority: 'high', channels: ['email'], template: 'refund_processed' },
  'order.created': { type: 'order', priority: 'medium', channels: ['email', 'push'], template: 'order_confirmation' },
  'order.shipped': { type: 'order', priority: 'medium', channels: ['email', 'push', 'sms'], template: 'order_shipped' },
  'order.delivered': { type: 'order', priority: 'medium', channels: ['push', 'sms'], template: 'order_delivered' },
  'system.maintenance': { type: 'system', priority: 'high', channels: ['email', 'push'], template: 'maintenance_notification' },
  'system.security_alert': { type: 'security', priority: 'critical', channels: ['email', 'sms', 'push'], template: 'security_alert' },
  'job.application_received': { type: 'job_alert', priority: 'medium', channels: ['email'], template: 'application_received' },
  'job.interview_scheduled': { type: 'job_alert', priority: 'high', channels: ['email', 'sms'], template: 'interview_scheduled' },
  'throne8.achievement_unlocked': { type: 'social', priority: 'medium', channels: ['push', 'in-app'], template: 'achievement_notification' },
  'throne8.level_up': { type: 'social', priority: 'medium', channels: ['push', 'in-app'], template: 'level_up' }
};

// Helper functions
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array(),
      correlationId: generateWebhookId()
    });
  }
  next();
};

const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(error => {
    console.error('Webhook Error:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Webhook processing failed',
      correlationId: generateWebhookId()
    });
  });
};

const generateWebhookId = () => {
  return `wh_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
};

async function enrichPayloadForEvent(event, payload, userId) {
  const enrichedPayload = { ...payload };
  const user = await NotificationUser.findOne({ userId, 'deletion.isDeleted': false });
  const userName = user?.profile?.displayName || user?.profile?.firstName || 'User';

  switch (event) {
    case 'user.registered':
      enrichedPayload.title = `Welcome to Throne8, ${userName}!`;
      enrichedPayload.body = `Your journey begins now. Let's get you started!`;
      enrichedPayload.actions = [{ id: 'complete_profile', label: 'Complete Profile', type: 'redirect', url: '/profile/edit' }];
      break;
    case 'social.like':
      enrichedPayload.title = `Someone liked your post!`;
      enrichedPayload.body = `${payload.likerName || 'Someone'} liked your ${payload.contentType || 'post'}`;
      enrichedPayload.actions = [{ id: 'view_post', label: 'View Post', type: 'redirect', url: payload.postUrl || '/post' }];
      enrichedPayload.groupId = payload.postId ? `post_like_${payload.postId}` : undefined;
      break;
    case 'social.comment':
      enrichedPayload.title = `New comment on your post`;
      enrichedPayload.body = `${payload.commenterName || 'Someone'} commented: "${payload.comment?.substring(0, 50) || 'New comment'}"`;
      enrichedPayload.actions = [
        { id: 'view_comment', label: 'View Comment', type: 'redirect', url: payload.commentUrl || '/post' },
        { id: 'reply', label: 'Reply', type: 'modal' }
      ];
      enrichedPayload.groupId = payload.postId ? `post_comment_${payload.postId}` : undefined;
      break;
    case 'payment.success':
      enrichedPayload.title = `Payment Successful`;
      enrichedPayload.body = `Your payment of ${payload.amount || 'amount'} has been processed successfully.`;
      enrichedPayload.actions = [{ id: 'view_receipt', label: 'View Receipt', type: 'redirect', url: payload.receiptUrl || '/receipt' }];
      break;
    case 'order.shipped':
      enrichedPayload.title = `Your order is on the way!`;
      enrichedPayload.body = `Order #${payload.orderNumber || 'N/A'} has been shipped and will arrive soon.`;
      enrichedPayload.actions = [{ id: 'track_order', label: 'Track Order', type: 'redirect', url: payload.trackingUrl || '/track' }];
      break;
    case 'throne8.achievement_unlocked':
      enrichedPayload.title = `Achievement Unlocked: ${payload.achievementName || 'New Achievement'}`;
      enrichedPayload.body = `Congratulations, ${userName}! You've unlocked ${payload.achievementName || 'a new achievement'}.`;
      enrichedPayload.actions = [{ id: 'view_achievement', label: 'View Achievement', type: 'redirect', url: payload.achievementUrl || '/achievements' }];
      break;
    case 'throne8.level_up':
      enrichedPayload.title = `Level Up: ${payload.level || 'New Level'}!`;
      enrichedPayload.body = `Great job, ${userName}! You've reached level ${payload.level || 'new level'}.`;
      enrichedPayload.actions = [{ id: 'view_profile', label: 'View Profile', type: 'redirect', url: '/profile' }];
      break;
    default:
      enrichedPayload.title = enrichedPayload.title || event.split('.').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
      enrichedPayload.body = enrichedPayload.body || payload.message || 'You have a new notification';
      break;
  }

  return enrichedPayload;
}

function determineUrgency(event, priority) {
  const urgentEvents = ['system.security_alert', 'payment.failed', 'user.password_changed'];
  if (urgentEvents.includes(event) || priority === 'critical') return 'immediate';
  if (priority === 'high') return 'urgent';
  return 'normal';
}

// Main webhook handler
export const handleWebhook = [
  webhookRateLimit,
  verifyWebhookSignature,
  ...validateWebhook,
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const webhookId = generateWebhookId();
    const startTime = Date.now();

    const {
      event,
      userId,
      channels = [],
      payload,
      metadata = {},
      priority,
      scheduled_for: scheduledFor,
      idempotency_key: idempotencyKey,
      groupId
    } = req.body;

    console.log(`Webhook received: ${event} for user ${userId}`, { webhookId, event, userId, channels });

    const cacheKey = idempotencyKey ? `webhook:${idempotencyKey}` : null;
    if (cacheKey) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const cachedResult = JSON.parse(cached);
        return res.json({
          success: true,
          message: 'Duplicate request ignored',
          notificationId: cachedResult.notificationId,
          webhookId
        });
      }
    }

    const eventConfig = EVENT_MAPPINGS[event] || { type: 'general', priority: 'medium', channels, template: null };
    let user = await NotificationUser.findOne({ userId, 'deletion.isDeleted': false });
    if (!user) {
      user = new NotificationUser({
        userId,
        contact: { email: '' },
        notificationPreferences: [{ type: eventConfig.type, channels: eventConfig.channels, enabled: true }]
      });
      await user.save();
      console.log(`Created user record for webhook: ${userId}`);
    }

    if (eventConfig.type === 'marketing' && !user.consents.find(c => c.type === 'marketing' && c.given)) {
      return res.status(403).json({ success: false, error: 'User has not consented to marketing notifications', webhookId });
    }

    const finalChannels = channels.length > 0 ? channels : eventConfig.channels;
    const allowedChannels = user ? finalChannels.filter(channel => user.canReceiveNotification(eventConfig.type, channel, priority || eventConfig.priority)) : finalChannels;
    if (allowedChannels.length === 0) {
      return res.json({ success: true, message: 'No allowed channels for user preferences', webhookId });
    }

    const rateLimitCheck = user ? user.checkRateLimit() : { allowed: true };
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded', reason: rateLimitCheck.reason, webhookId });
    }

    const deviceTokens = allowedChannels.some(ch => ['push', 'mobile'].includes(ch))
      ? await DeviceToken.findActiveByUser(userId, allowedChannels.includes('push') ? 'web' : 'mobile')
      : [];
    if (['push', 'mobile'].some(ch => allowedChannels.includes(ch)) && deviceTokens.length === 0) {
      return res.status(400).json({ success: false, error: 'No active device tokens for push/mobile channels', webhookId });
    }

    const enrichedPayload = await enrichPayloadForEvent(event, payload, userId);
    const notificationData = {
      userId,
      channels: allowedChannels,
      title: enrichedPayload.title,
      body: enrichedPayload.body,
      type: eventConfig.type,
      priority: priority || eventConfig.priority,
      urgency: determineUrgency(event, priority || eventConfig.priority),
      groupId: groupId || enrichedPayload.groupId,
      data: {
        ...enrichedPayload,
        source: 'webhook',
        webhookId,
        originalEvent: event,
        idempotencyKey,
        template: eventConfig.template,
        webhookMetadata: {
          ...metadata,
          sourceService: req.headers['x-source'],
          sourceVersion: req.headers['x-source-version'],
          userAgent: req.get('User-Agent'),
          ipAddress: req.ip,
          timestamp: new Date()
        }
      },
      scheduling: { scheduledFor: scheduledFor ? new Date(scheduledFor) : null },
      status: scheduledFor ? 'queued' : 'pending'
    };

    const notification = await Notification.create(notificationData);
    let sendResult = { success: true };

    if (!scheduledFor) {
      try {
        if (user) {
          await user.incrementRateLimit();
          await user.recordNotificationReceived(allowedChannels[0]);
        }

        sendResult = await notificationService.processNotification(notification);
        if (sendResult.success) {
          notification.status = 'sent';
          notification.processing.completedAt = new Date();
          notification.processing.processingTime = Date.now() - startTime;
          for (const channel of allowedChannels) {
            if (sendResult.results[channel]) {
              notification.updateDeliveryStatus(channel, sendResult.results[channel].status, {
                ...sendResult.results[channel].metadata,
                webhookProcessed: true
              });
              if (['push', 'mobile'].includes(channel)) {
                for (const token of deviceTokens) {
                  await token.recordNotificationSent(notification.type);
                  if (sendResult.results[channel].status === 'delivered') {
                    await token.recordNotificationDelivered(notification.type);
                  } else if (sendResult.results[channel].status === 'failed') {
                    await token.recordNotificationFailed(notification.type, sendResult.results[channel].metadata?.error);
                  }
                }
              }
            }
          }

          const io = req.app.get('io');
          if (io && allowedChannels.includes('in-app') && user.notificationPreferences.find(p => p.type === notification.type && p.channels.includes('in-app'))) {
            io.to(userId).emit('notification', {
              id: notification._id,
              notificationId: notification.notificationId,
              userId,
              title: notification.title,
              body: notification.body,
              type: notification.type,
              priority: notification.priority,
              channels: notification.channels,
              data: notification.data,
              createdAt: notification.createdAt,
              actions: notification.data.actions
            });
          }
        } else {
          notification.status = 'failed';
          notification.processing.lastError = {
            message: sendResult.error,
            code: sendResult.errorCode || 'WEBHOOK_SEND_FAILED',
            timestamp: new Date()
          };
          if (notification.retry.count < notification.retry.maxRetries) {
            notification.incrementRetry();
          }
          if (['push', 'mobile'].some(ch => allowedChannels.includes(ch))) {
            for (const token of deviceTokens) {
              await token.recordNotificationFailed(notification.type, sendResult.error);
            }
          }
        }

        await notification.save();
        webhookEvents.emit('notification:created', { webhookId, notificationId: notification.notificationId, userId, event });
      } catch (error) {
        console.error('Failed to process webhook notification:', error);
        notification.status = 'failed';
        notification.processing.lastError = { message: error.message, code: 'WEBHOOK_PROCESSING_ERROR', timestamp: new Date(), stack: error.stack };
        await notification.save();
        if (['push', 'mobile'].some(ch => allowedChannels.includes(ch))) {
          for (const token of deviceTokens) {
            await token.recordNotificationFailed(notification.type, error.message);
          }
        }
        webhookEvents.emit('notification:failed', { webhookId, notificationId: notification.notificationId, userId, event, error: error.message });
      }
    }

    if (cacheKey && sendResult.success) {
      await redis.setex(cacheKey, 24 * 60 * 60, JSON.stringify({
        notificationId: notification.notificationId,
        webhookId
      }));
    }

    res.json({
      success: true,
      webhookId,
      notificationId: notification.notificationId,
      event,
      userId,
      channels: allowedChannels,
      status: notification.status,
      scheduledFor: notification.scheduling?.scheduledFor,
      processingTime: Date.now() - startTime
    });
  })
];

// Batch webhook handler
export const handleBatchWebhook = [
  webhookRateLimit,
  verifyWebhookSignature,
  body('notifications')
    .isArray({ min: 1, max: 100 })
    .withMessage('Notifications array required (1-100 items)'),
  body('notifications.*.event').notEmpty().withMessage('Event is required for each notification'),
  body('notifications.*.userId').notEmpty().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  body('notifications.*.payload').isObject().custom(payload => JSON.stringify(payload).length <= 5120).withMessage('Payload too large (max 5KB)'),
  body('notifications.*.channels').optional().isArray({ min: 1, max: 5 }).custom(channels => channels.every(ch => ['email', 'push', 'sms', 'mobile', 'in-app', 'slack', 'teams'].includes(ch))).withMessage('Invalid channel'),
  body('notifications.*.priority').optional().isIn(['critical', 'high', 'medium', 'low']).withMessage('Invalid priority'),
  body('notifications.*.scheduled_for').optional().isISO8601().custom(value => new Date(value) > new Date()).withMessage('Scheduled time must be in the future'),
  body('notifications.*.groupId').optional().isString().isLength({ max: 50 }).withMessage('Invalid groupId'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const batchId = generateWebhookId();
    const startTime = Date.now();
    const { notifications, metadata = {} } = req.body;

    console.log(`Batch webhook received: ${notifications.length} notifications`, { batchId });

    const results = [];
    const errors = [];

    const notificationDocs = await Promise.all(notifications.map(async (notificationData, index) => {
      const { event, userId, channels = [], payload, priority, scheduled_for: scheduledFor, groupId, idempotency_key: idempotencyKey } = notificationData;
      const cacheKey = idempotencyKey ? `webhook:${idempotencyKey}` : null;
      if (cacheKey) {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const cachedResult = JSON.parse(cached);
          results.push({ success: true, notificationId: cachedResult.notificationId, event, userId, status: 'duplicate' });
          return null;
        }
      }

      const eventConfig = EVENT_MAPPINGS[event] || { type: 'general', priority: 'medium', channels };
      let user = await NotificationUser.findOne({ userId, 'deletion.isDeleted': false });
      if (!user) {
        user = new NotificationUser({
          userId,
          contact: { email: '' },
          notificationPreferences: [{ type: eventConfig.type, channels: eventConfig.channels, enabled: true }]
        });
        await user.save();
      }

      if (eventConfig.type === 'marketing' && !user.consents.find(c => c.type === 'marketing' && c.given)) {
        errors.push({ success: false, error: 'User has not consented to marketing notifications', event, userId });
        return null;
      }

      const finalChannels = channels.length > 0 ? channels : eventConfig.channels;
      const allowedChannels = user ? finalChannels.filter(ch => user.canReceiveNotification(eventConfig.type, ch, priority || eventConfig.priority)) : finalChannels;
      if (allowedChannels.length === 0) {
        results.push({ success: true, message: 'No allowed channels for user preferences', event, userId, status: 'skipped' });
        return null;
      }

      const rateLimitCheck = user ? user.checkRateLimit() : { allowed: true };
      if (!rateLimitCheck.allowed) {
        errors.push({ success: false, error: 'Rate limit exceeded', reason: rateLimitCheck.reason, event, userId });
        return null;
      }

      const deviceTokens = allowedChannels.some(ch => ['push', 'mobile'].includes(ch))
        ? await DeviceToken.findActiveByUser(userId, allowedChannels.includes('push') ? 'web' : 'mobile')
        : [];
      if (['push', 'mobile'].some(ch => allowedChannels.includes(ch)) && deviceTokens.length === 0) {
        errors.push({ success: false, error: 'No active device tokens for push/mobile channels', event, userId });
        return null;
      }

      const enrichedPayload = await enrichPayloadForEvent(event, payload, userId);
      return {
        userId,
        channels: allowedChannels,
        title: enrichedPayload.title,
        body: enrichedPayload.body,
        type: eventConfig.type,
        priority: priority || eventConfig.priority,
        urgency: determineUrgency(event, priority || eventConfig.priority),
        groupId: groupId || enrichedPayload.groupId,
        data: {
          ...enrichedPayload,
          source: 'webhook_batch',
          batchId,
          originalEvent: event,
          idempotencyKey,
          template: eventConfig.template,
          batchIndex: index,
          webhookMetadata: {
            ...metadata,
            sourceService: req.headers['x-source'],
            sourceVersion: req.headers['x-source-version'],
            userAgent: req.get('User-Agent'),
            ipAddress: req.ip,
            timestamp: new Date()
          }
        },
        scheduling: { scheduledFor: scheduledFor ? new Date(scheduledFor) : null },
        status: scheduledFor ? 'queued' : 'pending'
      };
    }));

    const validDocs = notificationDocs.filter(doc => doc !== null);
    // Changed variable name to avoid redeclaration
    const notificationDocsCreated = await Notification.insertMany(validDocs, { ordered: false });

    for (let i = 0; i < notificationDocsCreated.length; i++) {
      const notification = notificationDocsCreated[i];
      const doc = validDocs[i];
      if (!doc.scheduling?.scheduledFor && doc) {
        try {
          const user = await NotificationUser.findOne({ userId: doc.userId });
          if (user) {
            await user.incrementRateLimit();
            await user.recordNotificationReceived(doc.channels[0]);
          }

          const sendResult = await notificationService.processNotification(notification);
          if (sendResult.success) {
            notification.status = 'sent';
            notification.processing.completedAt = new Date();
            notification.processing.processingTime = Date.now() - startTime;
            for (const channel of doc.channels) {
              if (sendResult.results[channel]) {
                notification.updateDeliveryStatus(channel, sendResult.results[channel].status, {
                  ...sendResult.results[channel].metadata,
                  webhookProcessed: true
                });
                if (['push', 'mobile'].includes(channel)) {
                  const deviceTokens = await DeviceToken.findActiveByUser(doc.userId, channel === 'push' ? 'web' : 'mobile');
                  for (const token of deviceTokens) {
                    await token.recordNotificationSent(notification.type);
                    if (sendResult.results[channel].status === 'delivered') {
                      await token.recordNotificationDelivered(notification.type);
                    } else if (sendResult.results[channel].status === 'failed') {
                      await token.recordNotificationFailed(notification.type, sendResult.results[channel].metadata?.error);
                    }
                  }
                }
              }
            }

            const io = req.app.get('io');
            if (io && doc.channels.includes('in-app') && user.notificationPreferences.find(p => p.type === notification.type && p.channels.includes('in-app'))) {
              io.to(doc.userId).emit('notification', {
                id: notification._id,
                notificationId: notification.notificationId,
                userId: doc.userId,
                title: notification.title,
                body: notification.body,
                type: notification.type,
                priority: notification.priority,
                channels: notification.channels,
                data: notification.data,
                createdAt: notification.createdAt,
                actions: notification.data.actions
              });
            }
          } else {
            notification.status = 'failed';
            notification.processing.lastError = {
              message: sendResult.error,
              code: sendResult.errorCode || 'WEBHOOK_SEND_FAILED',
              timestamp: new Date()
            };
            if (notification.retry.count < notification.retry.maxRetries) {
              notification.incrementRetry();
            }
            if (['push', 'mobile'].some(ch => doc.channels.includes(ch))) {
              const deviceTokens = await DeviceToken.findActiveByUser(doc.userId, doc.channels.includes('push') ? 'web' : 'mobile');
              for (const token of deviceTokens) {
                await token.recordNotificationFailed(notification.type, sendResult.error);
              }
            }
          }

          await notification.save();
          results.push({ success: true, notificationId: notification.notificationId, event: doc.data.originalEvent, userId: doc.userId, status: notification.status });
          webhookEvents.emit('notification:created', { batchId, notificationId: notification.notificationId, userId: doc.userId, event: doc.data.originalEvent });
        } catch (error) {
          notification.status = 'failed';
          notification.processing.lastError = { message: error.message, code: 'WEBHOOK_PROCESSING_ERROR', timestamp: new Date(), stack: error.stack };
          await notification.save();
          errors.push({ success: false, error: error.message, event: doc.data.originalEvent, userId: doc.userId });
          webhookEvents.emit('notification:failed', { batchId, notificationId: notification.notificationId, userId: doc.userId, event: doc.data.originalEvent, error: error.message });
        }

        if (doc.data.idempotencyKey) {
          await redis.setex(`webhook:${doc.data.idempotencyKey}`, 24 * 60 * 60, JSON.stringify({
            notificationId: notification.notificationId,
            batchId
          }));
        }
      }
    }

    webhookEvents.emit('webhook:batch_processed', {
      batchId,
      totalRequested: notifications.length,
      successful: results.length,
      failed: errors.length,
      processingTime: Date.now() - startTime
    });

    res.json({
      success: true,
      batchId,
      summary: {
        totalRequested: notifications.length,
        successful: results.length,
        failed: errors.length,
        processingTime: Date.now() - startTime
      },
      results,
      errors: errors.length > 0 ? errors : undefined
    });
  })
];

// Delivery status webhook
export const handleDeliveryStatusWebhook = [
  webhookRateLimit,
  verifyWebhookSignature,
  body('notification_id').notEmpty().withMessage('Notification ID is required'),
  body('channel').isIn(['email', 'push', 'sms', 'mobile', 'in-app', 'slack', 'teams']).withMessage('Valid channel is required'),
  body('status').isIn(['sent', 'delivered', 'failed', 'bounced', 'seen', 'clicked']).withMessage('Valid status is required'),
  body('provider_id').optional().isString().withMessage('Provider ID must be a string'),
  body('error_message').optional().isString().withMessage('Error message must be a string'),
  body('timestamp').optional().isISO8601().withMessage('Invalid timestamp format'),
  body('metadata').optional().isObject().custom(metadata => JSON.stringify(metadata).length <= 2048).withMessage('Metadata too large (max 2KB)'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const webhookId = generateWebhookId();
    const { notification_id: notificationId, channel, status, provider_id: providerId, error_message: errorMessage, timestamp: statusTimestamp, metadata = {} } = req.body;

    let notification = await Notification.findOne({
      $or: [
        { notificationId },
        { _id: notificationId },
        { [`delivery.${channel}.providerId`]: providerId }
      ],
      'deletion.isDeleted': false
    });

    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found', webhookId });
    }

    const statusMetadata = {
      ...metadata,
      providerId,
      statusTimestamp: statusTimestamp ? new Date(statusTimestamp) : new Date(),
      webhookReceived: true
    };
    if (errorMessage) statusMetadata.error = errorMessage;

    notification.updateDeliveryStatus(channel, status, statusMetadata);
    if (status === 'delivered') {
      notification.status = 'delivered';
    } else if (status === 'failed' || status === 'bounced') {
      if (notification.retry.count < notification.retry.maxRetries) {
        notification.status = 'failed';
        notification.incrementRetry();
      }
    }

    await notification.save();

    if (notification.userId && ['delivered', 'seen', 'clicked'].includes(status)) {
      const user = await NotificationUser.findOne({ userId: notification.userId });
      if (user) {
        if (status === 'delivered') {
          await user.recordNotificationReceived(channel);
        } else if (status === 'seen') {
          await user.recordNotificationEngagement('seen', channel);
        } else if (status === 'clicked') {
          await user.recordNotificationEngagement('clicked', channel);
        }
      }

      if (['push', 'mobile'].includes(channel)) {
        const deviceTokens = await DeviceToken.findActiveByUser(notification.userId, channel === 'push' ? 'web' : 'mobile');
        for (const token of deviceTokens) {
          if (status === 'delivered') {
            await token.recordNotificationDelivered(notification.type);
          } else if (status === 'seen') {
            await token.recordNotificationDelivered(notification.type); // Seen implies delivered
          } else if (status === 'clicked') {
            await token.recordNotificationClicked(notification.type);
          } else if (status === 'failed' || status === 'bounced') {
            await token.recordNotificationFailed(notification.type, errorMessage);
          }
        }
      }
    }

    webhookEvents.emit('delivery_status:updated', {
      notificationId: notification.notificationId,
      channel,
      status,
      userId: notification.userId
    });

    res.json({
      success: true,
      notificationId: notification.notificationId,
      channel,
      status,
      updatedAt: new Date(),
      webhookId
    });
  })
];

// Webhook logs endpoint
export const getWebhookLogs = [
  query('startDate').optional().isISO8601().withMessage('Invalid start date'),
  query('endDate').optional().isISO8601().withMessage('Invalid end date'),
  query('event').optional().isString().withMessage('Event must be a string'),
  query('userId').optional().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Valid userId required'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('skip').optional().isInt({ min: 0 }).withMessage('Skip must be non-negative'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const webhookId = generateWebhookId();
    const { startDate, endDate, event, userId, limit = 50, skip = 0 } = req.query;
    const cacheKey = `webhook_logs:${userId || 'all'}:${event || 'all'}:${startDate || 'none'}:${endDate || 'none'}:${limit}:${skip}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const query = {
      'data.source': { $in: ['webhook', 'webhook_batch'] },
      'deletion.isDeleted': false
    };
    if (userId) query.userId = userId;
    if (event) query['data.originalEvent'] = event;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const logs = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .select('notificationId userId data.originalEvent data.webhookId channels status createdAt data.webhookMetadata')
      .lean();

    const totalCount = await Notification.countDocuments(query);
    const response = {
      success: true,
      logs,
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        skip: parseInt(skip),
        currentPage: Math.floor(parseInt(skip) / parseInt(limit)) + 1,
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        hasMore: totalCount > parseInt(skip) + parseInt(limit)
      },
      webhookId
    };

    await redis.setex(cacheKey, 3600, JSON.stringify(response));
    res.json(response);
  })
];

// Webhook health check
export const webhookHealthCheck = [
  asyncHandler(async (req, res) => {
    const webhookId = generateWebhookId();
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentWebhookNotifications = await Notification.countDocuments({
        'data.source': { $in: ['webhook', 'webhook_batch'] },
        createdAt: { $gte: oneHourAgo }
      });
      const failedWebhookNotifications = await Notification.countDocuments({
        'data.source': { $in: ['webhook', 'webhook_batch'] },
        createdAt: { $gte: oneHourAgo },
        status: 'failed'
      });
      const successRate = recentWebhookNotifications > 0
        ? ((recentWebhookNotifications - failedWebhookNotifications) / recentWebhookNotifications) * 100
        : 100;

      const health = {
        status: successRate >= 95 ? 'healthy' : successRate >= 80 ? 'degraded' : 'unhealthy',
        timestamp: new Date(),
        metrics: {
          recentWebhooks: recentWebhookNotifications,
          failedWebhooks: failedWebhookNotifications,
          successRate: Math.round(successRate * 100) / 100,
          supportedEvents: Object.keys(EVENT_MAPPINGS).length,
          webhookVersion: '1.0.0'
        }
      };

      res.json({ success: true, health, webhookId });
    } catch (error) {
      res.status(500).json({
        success: false,
        health: { status: 'unhealthy', timestamp: new Date(), error: error.message },
        webhookId
      });
    }
  })
];

export { EVENT_MAPPINGS };