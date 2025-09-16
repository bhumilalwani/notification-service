import mongoose from 'mongoose';
import { EventEmitter } from 'events';
import winston from 'winston';
import { createHash } from 'crypto';
import { notificationEvents } from './Notification.js';

const { Schema, model } = mongoose;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/deviceToken.log' })
  ]
});

// Custom event emitter for device token events
export const deviceTokenEvents = new EventEmitter({ captureRejections: true });

// DeviceToken Schema
const DeviceTokenSchema = new Schema({
  tokenId: {
    type: String,
    unique: true,
    default: () => createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16),
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true,
    maxlength: 50,
    match: /^[a-zA-Z0-9_-]+$/
  },
  platform: {
    type: String,
    enum: ['ios', 'android', 'web'],
    required: true,
    index: true
  },
  token: {
    type: String,
    required: true,
    maxlength: 4096,
    validate: {
      validator: function(v) {
        if (!v || v.trim().length === 0) return false;
        if (this.platform === 'ios' && !/^[0-9a-fA-F]{64}$/.test(v)) return false;
        if (this.platform === 'android' && v.length < 50) return false; // Relaxed from 100 to 50
        if (this.platform === 'web' && !v.startsWith('https://')) return false;
        return true;
      },
      message: 'Invalid token format for platform {VALUE}'
    }
  },
  provider: {
    service: {
      type: String,
      enum: ['fcm', 'apns', 'web-push'],
      required: true
    },
    endpoint: { type: String, maxlength: 500, sparse: true },
    keys: {
      p256dh: { 
        type: String, 
        maxlength: 200, 
        sparse: true,
        required: function() { return this.platform === 'web'; }, // Required for web platform
        validate: {
          validator: function(v) {
            return this.platform !== 'web' || (v && v.length > 0);
          },
          message: 'p256dh key is required for web platform'
        }
      },
      auth: { 
        type: String, 
        maxlength: 200, 
        sparse: true,
        required: function() { return this.platform === 'web'; }, // Required for web platform
        validate: {
          validator: function(v) {
            return this.platform !== 'web' || (v && v.length > 0);
          },
          message: 'auth key is required for web platform'
        }
      }
    }
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'invalid', 'expired'],
    default: 'active',
    index: true
  },
  metrics: {
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    clicked: { type: Number, default: 0 },
    lastSentAt: { type: Date },
    lastDeliveredAt: { type: Date },
    lastClickedAt: { type: Date },
    lastActiveAt: { type: Date, default: Date.now }
  },
  lifecycle: {
    registeredAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
    lastRefreshedAt: { type: Date }
  },
  deletion: {
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date }
  }
}, {
  timestamps: true,
  versionKey: false,
  minimize: false,
  collection: 'device_tokens'
});

// Optimized Indexes
DeviceTokenSchema.index({ userId: 1, platform: 1, status: 1 });
DeviceTokenSchema.index({ token: 1, platform: 1 }, { unique: true, partialFilterExpression: { 'deletion.isDeleted': false } });
DeviceTokenSchema.index({ 'lifecycle.expiresAt': 1, status: 1 });
DeviceTokenSchema.index({ 'deletion.isDeleted': 1, 'deletion.deletedAt': 1 }, { expireAfterSeconds: 2592000, partialFilterExpression: { 'deletion.isDeleted': true } });

// Virtuals
DeviceTokenSchema.virtual('isActive').get(function() {
  return this.status === 'active' && !this.deletion.isDeleted && (!this.lifecycle.expiresAt || this.lifecycle.expiresAt > new Date());
});

// Instance Methods

// FIXED: Single refreshToken method that handles both use cases
DeviceTokenSchema.methods.refreshToken = async function(newToken, updates = {}) {
  try {
    this.token = newToken;
    this.lifecycle.lastRefreshedAt = new Date();
    this.status = 'active';
    
    // Merge any additional updates (security, deviceInfo, etc.)
    if (updates.security) {
      this.security = { ...this.security, ...updates.security };
    }
    if (updates.deviceInfo) {
      this.deviceInfo = { ...this.deviceInfo, ...updates.deviceInfo };
    }
    
    await this.save();
    deviceTokenEvents.emit('token:refreshed', { tokenId: this.tokenId, userId: this.userId, platform: this.platform });
    logger.info('Token refreshed', { tokenId: this.tokenId, userId: this.userId, platform: this.platform });
    return this;
  } catch (error) {
    logger.error('Failed to refresh token', { tokenId: this.tokenId, userId: this.userId, error: error?.stack });
    throw error;
  }
};

DeviceTokenSchema.methods.updateActivity = async function() {
  try {
    this.metrics.lastActiveAt = new Date();
    await this.save();
    deviceTokenEvents.emit('token:activity_updated', { tokenId: this.tokenId, userId: this.userId });
    logger.info('Token activity updated', { tokenId: this.tokenId, userId: this.userId });
    return this;
  } catch (error) {
    logger.error('Failed to update token activity', { tokenId: this.tokenId, userId: this.userId, error: error?.stack });
    throw error;
  }
};

DeviceTokenSchema.methods.recordNotificationSent = async function(type) {
  try {
    this.metrics.sent += 1;
    this.metrics.lastSentAt = new Date();
    await this.save();
    deviceTokenEvents.emit('notification:sent', { tokenId: this.tokenId, userId: this.userId, type });
    logger.info('Notification sent recorded', { tokenId: this.tokenId, userId: this.userId, type });
    return this;
  } catch (error) {
    logger.error('Failed to record notification sent', { tokenId: this.tokenId, userId: this.userId, type, error: error?.stack });
    throw error;
  }
};

DeviceTokenSchema.methods.recordNotificationDelivered = async function(type) {
  try {
    this.metrics.delivered += 1;
    this.metrics.lastDeliveredAt = new Date();
    await this.save();
    deviceTokenEvents.emit('notification:delivered', { tokenId: this.tokenId, userId: this.userId, type });
    logger.info('Notification delivered recorded', { tokenId: this.tokenId, userId: this.userId, type });
    return this;
  } catch (error) {
    logger.error('Failed to record notification delivered', { tokenId: this.tokenId, userId: this.userId, type, error: error?.stack });
    throw error;
  }
};

DeviceTokenSchema.methods.recordNotificationFailed = async function(type, error = null) {
  try {
    this.metrics.failed += 1;
    if (error?.message?.match(/(invalid|token)/i)) {
      this.status = this.metrics.failed >= 3 ? 'invalid' : this.status;
    }
    await this.save();
    deviceTokenEvents.emit('notification:failed', { tokenId: this.tokenId, userId: this.userId, type, error: error?.message });
    logger.warn('Notification failed recorded', { tokenId: this.tokenId, userId: this.userId, type, error: error?.message });
    return this;
  } catch (error) {
    logger.error('Failed to record notification failure', { tokenId: this.tokenId, userId: this.userId, type, error: error?.stack });
    throw error;
  }
};

DeviceTokenSchema.methods.recordNotificationClicked = async function(type) {
  try {
    this.metrics.clicked += 1;
    this.metrics.lastClickedAt = new Date();
    await this.save();
    deviceTokenEvents.emit('notification:clicked', { tokenId: this.tokenId, userId: this.userId, type });
    logger.info('Notification clicked recorded', { tokenId: this.tokenId, userId: this.userId, type });
    return this;
  } catch (error) {
    logger.error('Failed to record notification click', { tokenId: this.tokenId, userId: this.userId, type, error: error?.stack });
    throw error;
  }
};

DeviceTokenSchema.methods.validateToken = async function(pushService) {
  try {
    await pushService.validateToken(this.token, this.platform);
    this.status = 'active';
    await this.save();
    deviceTokenEvents.emit('token:validated', { tokenId: this.tokenId, userId: this.userId });
    logger.info('Token validated', { tokenId: this.tokenId, userId: this.userId });
    return { valid: true };
  } catch (error) {
    this.status = this.metrics.failed >= 3 ? 'invalid' : this.status;
    await this.save();
    deviceTokenEvents.emit('token:validation_failed', { tokenId: this.tokenId, userId: this.userId, error: error?.message });
    logger.warn('Token validation failed', { tokenId: this.tokenId, userId: this.userId, error: error?.stack });
    return { valid: false, error: error?.message };
  }
};

DeviceTokenSchema.methods.deactivate = async function(reason = 'user_logout') {
  try {
    this.status = 'inactive';
    this.lifecycle.deactivatedAt = new Date();
    await this.save();
    deviceTokenEvents.emit('token:deactivated', { tokenId: this.tokenId, userId: this.userId, platform: this.platform, reason });
    logger.info('Token deactivated', { tokenId: this.tokenId, userId: this.userId, platform: this.platform, reason });
    return this;
  } catch (error) {
    logger.error('Failed to deactivate token', { tokenId: this.tokenId, userId: this.userId, error: error?.stack });
    throw error;
  }
};

DeviceTokenSchema.methods.softDelete = async function(reason = 'user_request') {
  try {
    this.deletion.isDeleted = true;
    this.deletion.deletedAt = new Date();
    this.status = 'inactive';
    await this.save();
    deviceTokenEvents.emit('token:deleted', { tokenId: this.tokenId, userId: this.userId, platform: this.platform, reason });
    logger.info('Token soft deleted', { tokenId: this.tokenId, userId: this.userId, platform: this.platform, reason });
    return this;
  } catch (error) {
    logger.error('Failed to soft delete token', { tokenId: this.tokenId, userId: this.userId, error: error?.stack });
    throw error;
  }
};

// Static Methods
DeviceTokenSchema.statics.findActiveByUser = async function(userId, platform = null) {
  try {
    const query = { userId, status: 'active', 'deletion.isDeleted': false };
    if (platform) query.platform = platform;
    const tokens = await this.find(query);
    logger.debug('Fetched active tokens', { userId, platform, count: tokens.length });
    return tokens;
  } catch (error) {
    logger.error('Failed to fetch active tokens', { userId, platform, error: error?.stack });
    throw error;
  }
};

DeviceTokenSchema.statics.findByToken = async function(token, platform) {
  try {
    const tokenDoc = await this.findOne({ token, platform, 'deletion.isDeleted': false });
    logger.debug('Fetched token by value', { token, platform, found: !!tokenDoc });
    return tokenDoc;
  } catch (error) {
    logger.error('Failed to fetch token by value', { token, platform, error: error?.stack });
    throw error;
  }
};

DeviceTokenSchema.statics.findByEndpoint = async function(endpoint) {
  try {
    // Don't use .lean() so instance methods are available
    const tokenDoc = await this.findOne({ 
      'provider.endpoint': endpoint, 
      'deletion.isDeleted': false 
    });
    logger.debug('Fetched token by endpoint', { endpoint, found: !!tokenDoc });
    return tokenDoc;
  } catch (error) {
    logger.error('Failed to fetch token by endpoint', { endpoint, error: error?.stack });
    throw error;
  }
};

DeviceTokenSchema.statics.cleanupExpiredTokens = async function(batchSize = 1000) {
  try {
    const result = await this.updateMany(
      { 'lifecycle.expiresAt': { $lte: new Date() }, status: { $ne: 'expired' }, 'deletion.isDeleted': false },
      { $set: { status: 'expired' } },
      { maxTimeMS: 30000 }
    ).limit(batchSize);
    logger.info('Cleaned up expired tokens', { modifiedCount: result.modifiedCount });
    return result;
  } catch (error) {
    logger.error('Failed to clean up expired tokens', { error: error?.stack });
    throw error;
  }
};

// Pre-save Middleware
DeviceTokenSchema.pre('save', async function(next) {
  try {
    if (this.isNew && !this.lifecycle.expiresAt) {
      this.lifecycle.expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    }
    next();
  } catch (error) {
    logger.error('Pre-save middleware error', { tokenId: this.tokenId, userId: this.userId, error: error?.stack });
    next(error);
  }
});

// Post-save Middleware
DeviceTokenSchema.post('save', async function(doc, next) {
  try {
    if (doc.isNew) {
      deviceTokenEvents.emit('token:registered', { tokenId: doc.tokenId, userId: doc.userId, platform: doc.platform });
      notificationEvents.emit('device:registered', { userId: doc.userId, platform: doc.platform });
      logger.info('Token registered', { tokenId: doc.tokenId, userId: doc.userId, platform: doc.platform });
    }
    if (doc.isModified('status')) {
      deviceTokenEvents.emit('token:status_changed', { tokenId: doc.tokenId, userId: doc.userId, platform: doc.platform, newStatus: doc.status });
      logger.info('Token status changed', { tokenId: doc.tokenId, userId: doc.userId, platform: doc.platform, newStatus: doc.status });
    }
    next();
  } catch (error) {
    logger.error('Post-save middleware error', { tokenId: doc.tokenId, userId: doc.userId, error: error?.stack });
    next(error);
  }
});

// Error Handling
DeviceTokenSchema.post('save', function(error, doc, next) {
  if (error.name === 'MongoServerError' && error.code === 11000) {
    logger.error('Duplicate token error', { tokenId: doc.tokenId, userId: doc.userId, error: error?.stack });
    next(new Error('Device token already exists for this platform'));
  } else {
    logger.error('Save error', { tokenId: doc.tokenId, userId: doc.userId, error: error?.stack });
    next(error);
  }
});

// Create and Export Model
const DeviceToken = model('DeviceToken', DeviceTokenSchema);
DeviceToken.createIndexes().catch(err => logger.error('Index creation failed', { error: err?.stack }));
export default DeviceToken;