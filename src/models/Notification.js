import mongoose from 'mongoose';
import crypto from 'crypto';
import { EventEmitter } from 'events';

const { Schema, model } = mongoose;

// Custom event emitter for notification events
export const notificationEvents = new EventEmitter();

const NotificationSchema = new Schema({
  // Unique identifier for deduplication
  notificationId: {
    type: String,
    unique: true,
    required: true,
    default: () => crypto.randomUUID(),
  },
  // User identification
  userId: {
    type: String,
    required: true,
    maxlength: 50,
    validate: {
      validator: function(v) {
        return /^[a-zA-Z0-9_-]+$/.test(v);
      },
      message: 'UserId must contain only alphanumeric characters, underscores, and hyphens'
    }
  },
  // Notification content
  title: {
    type: String,
    required: true,
    maxlength: 200,
    trim: true,
    validate: {
      validator: function(v) {
        return v && v.trim().length > 0;
      },
      message: 'Title cannot be empty'
    }
  },
  body: {
    type: String,
    required: true,
    maxlength: 1000,
    trim: true,
    validate: {
      validator: function(v) {
        return v && v.trim().length > 0;
      },
      message: 'Body cannot be empty'
    }
  },
  // Rich content support
  richContent: {
    html: { type: String, maxlength: 2000 },
    markdown: { type: String, maxlength: 2000 },
    attachments: [{
      type: {
        type: String,
        enum: ['image', 'file', 'video', 'audio'],
        required: true
      },
      url: { type: String, required: true, maxlength: 500 },
      name: { type: String, maxlength: 100 },
      size: { type: Number, min: 0 },
      mimeType: { type: String, maxlength: 100 }
    }]
  },
  // Categorization
  type: {
    type: String,
    default: 'general',
    enum: [
      'general', 'security', 'marketing', 'system',
      'urgent', 'promotional', 'reminder', 'social',
      'payment', 'order', 'message', 'alert', 'like',
      'comment', 'follow', 'connection_request', 'job_alert',
      'mention', 'share', 'endorsement', 'profile_view',
      'birthday', 'work_anniversary', 'group_invite', 'event_invite',
      'content_update'
    ]
  },
  subType: {
    type: String,
    maxlength: 50
  },
  // Delivery channels
  channels: [{
    type: String,
    enum: ['email', 'push', 'sms', 'mobile', 'webhook', 'in-app', 'slack', 'teams'],
    required: true
  }],
  // Priority for queue processing
  priority: {
    type: String,
    enum: ['critical', 'high', 'medium', 'low'],
    default: 'medium'
  },
  // Urgency level
  urgency: {
    type: String,
    enum: ['immediate', 'urgent', 'normal', 'low'],
    default: 'normal'
  },
  // Enhanced metadata
  data: {
    actions: [{
      id: { type: String, required: true },
      label: { type: String, required: true, maxlength: 50 },
      url: { type: String, maxlength: 500 },
      type: {
        type: String,
        enum: ['redirect', 'modal', 'api_call', 'dismiss', 'custom'],
        required: true
      },
      style: {
        type: String,
        enum: ['primary', 'secondary', 'danger', 'success', 'warning'],
        default: 'primary'
      },
      payload: { type: Schema.Types.Mixed }
    }],
    campaignId: { type: String, maxlength: 50 },
    batchId: { type: String, maxlength: 50 },
    correlationId: { type: String, maxlength: 100 },
    templateId: { type: String, maxlength: 50 },
    templateVersion: { type: String, maxlength: 20 },
    variables: {
      type: Map,
      of: Schema.Types.Mixed,
      validate: {
        validator: function(v) {
          return JSON.stringify(v).length <= 2048;
        },
        message: 'Variables data exceeds 2KB limit'
      }
    },
    locale: { type: String, default: 'en-US', maxlength: 10 },
    timezone: { type: String, default: 'UTC', maxlength: 50 },
    source: { type: String, maxlength: 100 },
    sourceVersion: { type: String, maxlength: 20 },
    environment: {
      type: String,
      enum: ['development', 'staging', 'production'],
      default: 'production'
    },
    category: { type: String, maxlength: 50 },
    tags: [{
      type: String,
      maxlength: 50,
      validate: {
        validator: function(v) {
          return /^[a-zA-Z0-9_-]+$/.test(v);
        },
        message: 'Tags must contain only alphanumeric characters, underscores, and hyphens'
      }
    }],
    entityId: { type: String, maxlength: 50 },
    entityType: { type: String, maxlength: 50 },
    consentId: { type: String, maxlength: 100 },
    gdprCompliant: { type: Boolean, default: true },
    dataRetentionDays: { type: Number, default: 90, min: 1, max: 2555 }
  },
  // Status tracking
  status: {
    type: String,
    default: 'pending',
    enum: [
      'draft', 'pending', 'queued', 'sending', 'sent',
      'delivered', 'failed', 'cancelled', 'expired', 'archived'
    ]
  },
  // Processing metadata
  processing: {
    queuedAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    processingTime: { type: Number },
    queueTime: { type: Number },
    workerId: { type: String, maxlength: 100 },
    attempts: { type: Number, default: 0 },
    lastError: {
      message: { type: String, maxlength: 500 },
      code: { type: String, maxlength: 50 },
      timestamp: { type: Date },
      stack: { type: String, maxlength: 2000 }
    }
  },
  // Interaction tracking
  interactions: {
    seen: {
      type: Boolean,
      default: false
    },
    seenAt: {
      type: Date
    },
    seenCount: { type: Number, default: 0 },
    clicked: {
      type: Boolean,
      default: false
    },
    clickedAt: {
      type: Date
    },
    clickCount: { type: Number, default: 0 },
    dismissed: { type: Boolean, default: false },
    dismissedAt: { type: Date },
    actionsPerformed: [{
      actionId: { type: String, required: true },
      performedAt: { type: Date, default: Date.now },
      result: { type: String, enum: ['success', 'failed', 'cancelled'] },
      metadata: { type: Schema.Types.Mixed }
    }]
  },
  // Delivery tracking
  delivery: {
    email: {
      status: {
        type: String,
        enum: ['pending', 'sent', 'delivered', 'bounced', 'failed', 'spam', 'blocked'],
        default: 'pending'
      },
      provider: { type: String, maxlength: 50 },
      providerId: { type: String, maxlength: 100 },
      to: { type: String, maxlength: 100 },
      subject: { type: String, maxlength: 200 },
      sentAt: { type: Date },
      deliveredAt: { type: Date },
      openedAt: { type: Date },
      clickedAt: { type: Date },
      bounceReason: { type: String, maxlength: 200 },
      error: { type: String, maxlength: 500 },
      messageId: { type: String, maxlength: 100 },
      webhookData: { type: Schema.Types.Mixed }
    },
    push: {
      status: {
        type: String,
        enum: ['pending', 'sent', 'delivered', 'failed', 'expired'],
        default: 'pending'
      },
      provider: { type: String, maxlength: 50 },
      providerId: { type: String, maxlength: 100 },
      deviceToken: { type: String, maxlength: 200 },
      platform: { type: String, enum: ['ios', 'android', 'web'] },
      sentAt: { type: Date },
      deliveredAt: { type: Date },
      clickedAt: { type: Date },
      error: { type: String, maxlength: 500 },
      clickCount: { type: Number, default: 0 },
      sound: { type: String, maxlength: 50 },
      badge: { type: Number },
      category: { type: String, maxlength: 50 }
    },
    sms: {
      status: {
        type: String,
        enum: ['pending', 'sent', 'delivered', 'failed', 'expired'],
        default: 'pending'
      },
      provider: { type: String, maxlength: 50 },
      providerId: { type: String, maxlength: 100 },
      to: { type: String, maxlength: 20 },
      sentAt: { type: Date },
      deliveredAt: { type: Date },
      error: { type: String, maxlength: 500 },
      messageId: { type: String, maxlength: 100 },
      cost: { type: Number, min: 0 },
      segments: { type: Number, default: 1 }
    },
    mobile: {
      status: {
        type: String,
        enum: ['pending', 'sent', 'delivered', 'failed'],
        default: 'pending'
      },
      sentAt: { type: Date },
      deliveredAt: { type: Date },
      error: { type: String, maxlength: 500 },
      platform: { type: String, enum: ['ios', 'android'] },
      notificationId: { type: String, maxlength: 100 },
      appVersion: { type: String, maxlength: 20 }
    },
    webhook: {
      status: {
        type: String,
        enum: ['pending', 'sent', 'delivered', 'failed'],
        default: 'pending'
      },
      url: { type: String, maxlength: 500 },
      method: { type: String, enum: ['GET', 'POST', 'PUT'], default: 'POST' },
      headers: { type: Map, of: String },
      payload: { type: Schema.Types.Mixed },
      responseStatus: { type: Number },
      responseBody: { type: String, maxlength: 1000 },
      sentAt: { type: Date },
      responseAt: { type: Date },
      error: { type: String, maxlength: 500 }
    }
  },
  // Scheduling
  scheduling: {
    scheduledFor: {
      type: Date
    },
    timezone: { type: String, default: 'UTC' },
    recurring: {
      enabled: { type: Boolean, default: false },
      pattern: {
        type: String,
        enum: ['daily', 'weekly', 'monthly', 'yearly', 'custom']
      },
      interval: { type: Number, min: 1 },
      daysOfWeek: [{ type: Number, min: 0, max: 6 }],
      daysOfMonth: [{ type: Number, min: 1, max: 31 }],
      months: [{ type: Number, min: 1, max: 12 }],
      endDate: { type: Date },
      maxOccurrences: { type: Number, min: 1 }
    }
  },
  // TTL for cleanup
  expiresAt: {
    type: Date,
    index: { expireAfterSeconds: 0 }
  },
  // Retry mechanism
  retry: {
    count: { type: Number, default: 0, max: 10 },
    maxRetries: { type: Number, default: 3, max: 10 },
    nextRetryAt: { type: Date },
    backoffMultiplier: { type: Number, default: 2, min: 1, max: 10 },
    baseDelay: { type: Number, default: 60000, min: 1000 },
    maxDelay: { type: Number, default: 3600000 },
    strategy: {
      type: String,
      enum: ['exponential', 'linear', 'fixed'],
      default: 'exponential'
    }
  },
  // Audience and targeting
  targeting: {
    userSegments: [{ type: String, maxlength: 50 }],
    deviceTypes: [{ type: String, enum: ['mobile', 'tablet', 'desktop', 'watch'] }],
    platforms: [{ type: String, enum: ['ios', 'android', 'web', 'desktop'] }],
    appVersions: [{ type: String, maxlength: 20 }],
    countries: [{ type: String, maxlength: 2 }],
    languages: [{ type: String, maxlength: 10 }],
    customFilters: { type: Schema.Types.Mixed }
  },
  // A/B Testing
  experiment: {
    id: { type: String, maxlength: 50 },
    variant: { type: String, maxlength: 50 },
    group: { type: String, maxlength: 50 }
  },
  // Performance metrics
  metrics: {
    deliveryRate: { type: Number, min: 0, max: 1 },
    openRate: { type: Number, min: 0, max: 1 },
    clickRate: { type: Number, min: 0, max: 1 },
    conversionRate: { type: Number, min: 0, max: 1 },
    cost: { type: Number, min: 0 },
    revenue: { type: Number, min: 0 }
  },
  // Compliance and audit
  compliance: {
    gdprCompliant: { type: Boolean, default: true },
    ccpaCompliant: { type: Boolean, default: true },
    consentRequired: { type: Boolean, default: false },
    consentGiven: { type: Boolean },
    consentTimestamp: { type: Date },
    dataProcessingBasis: {
      type: String,
      enum: ['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests']
    },
    auditLog: [{
      action: { type: String, required: true, maxlength: 100 },
      userId: { type: String, maxlength: 50 },
      timestamp: { type: Date, default: Date.now },
      metadata: { type: Schema.Types.Mixed }
    }]
  },
  // Soft delete
  deletion: {
    isDeleted: {
      type: Boolean,
      default: false
    },
    deletedAt: { type: Date },
    deletedBy: { type: String, maxlength: 50 },
    deletionReason: {
      type: String,
      enum: ['user_request', 'gdpr', 'expired', 'admin', 'automated'],
      maxlength: 50
    }
  },
  // Grouping
  groupId: {
    type: String,
    maxlength: 50
  },
  // Related user
  relatedUserId: {
    type: String,
    maxlength: 50
  }
}, {
  timestamps: true,
  versionKey: '__v',
  minimize: false,
  collection: 'notifications',
  read: 'secondaryPreferred',
  optimisticConcurrency: true
});

// Compound indexes
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, 'interactions.seen': 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, type: 1, createdAt: -1 });
NotificationSchema.index({ status: 1, 'scheduling.scheduledFor': 1 });
NotificationSchema.index({ status: 1, 'retry.nextRetryAt': 1 });
NotificationSchema.index({ 'data.campaignId': 1, createdAt: -1 });
NotificationSchema.index({ 'data.batchId': 1, status: 1 });
NotificationSchema.index({ priority: 1, createdAt: 1 });
NotificationSchema.index({ type: 1, createdAt: -1 });
NotificationSchema.index({ 'deletion.isDeleted': 1, createdAt: -1 });
NotificationSchema.index({ 'data.correlationId': 1 });
NotificationSchema.index({ groupId: 1 });
NotificationSchema.index({ relatedUserId: 1, userId: 1 });

// Partial indexes
NotificationSchema.index(
  { userId: 1, 'interactions.seen': 1 },
  { partialFilterExpression: { 'interactions.seen': false } }
);
NotificationSchema.index(
  { userId: 1, status: 1 },
  { partialFilterExpression: { status: { $in: ['pending', 'queued', 'sending'] } } }
);
NotificationSchema.index(
  { expiresAt: 1, status: 1 },
  { partialFilterExpression: { status: { $in: ['pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'cancelled'] } } }
);

// Text search index
NotificationSchema.index({
  title: 'text',
  body: 'text',
  'data.tags': 'text'
}, {
  weights: {
    title: 10,
    body: 5,
    'data.tags': 1
  },
  name: 'notification_search'
});

// Virtual fields
NotificationSchema.virtual('isExpired').get(function() {
  return this.expiresAt && this.expiresAt < new Date();
});
NotificationSchema.virtual('needsRetry').get(function() {
  return this.status === 'failed' &&
         this.retry.count < this.retry.maxRetries &&
         this.retry.nextRetryAt &&
         this.retry.nextRetryAt <= new Date();
});
NotificationSchema.virtual('deliverySuccess').get(function() {
  const channels = this.channels || [];
  return channels.some(channel =>
    this.delivery[channel] &&
    ['delivered', 'sent'].includes(this.delivery[channel].status)
  );
});
NotificationSchema.virtual('overallStatus').get(function() {
  if (this.deletion.isDeleted) return 'deleted';
  if (this.isExpired) return 'expired';
  if (this.status === 'failed' && this.retry.count >= this.retry.maxRetries) return 'permanently_failed';
  return this.status;
});

// Instance methods
NotificationSchema.methods.markAsSeen = async function() {
  if (!this.interactions.seen) {
    this.interactions.seen = true;
    this.interactions.seenAt = new Date();
    this.interactions.seenCount = (this.interactions.seenCount || 0) + 1;
    this.compliance.auditLog.push({
      action: 'marked_seen',
      timestamp: new Date()
    });
    await this.save();
    notificationEvents.emit('notification:seen', { notificationId: this._id, userId: this.userId });
  }
  return this;
};

NotificationSchema.methods.markAsClicked = async function(actionId = null) {
  this.interactions.clicked = true;
  this.interactions.clickedAt = new Date();
  this.interactions.clickCount = (this.interactions.clickCount || 0) + 1;
  if (actionId) {
    this.interactions.actionsPerformed.push({
      actionId,
      performedAt: new Date(),
      result: 'success'
    });
  }
  this.compliance.auditLog.push({
    action: actionId ? `clicked_action:${actionId}` : 'clicked',
    timestamp: new Date()
  });
  await this.save();
  notificationEvents.emit('notification:clicked', {
    notificationId: this._id,
    userId: this.userId,
    actionId
  });
  return this;
};

NotificationSchema.methods.dismiss = async function() {
  this.interactions.dismissed = true;
  this.interactions.dismissedAt = new Date();
  this.compliance.auditLog.push({
    action: 'dismissed',
    timestamp: new Date()
  });
  await this.save();
  notificationEvents.emit('notification:dismissed', {
    notificationId: this._id,
    userId: this.userId
  });
  return this;
};

NotificationSchema.methods.incrementRetry = function() {
  this.retry.count += 1;
  let delay;
  switch (this.retry.strategy) {
    case 'exponential':
      delay = Math.min(
        this.retry.baseDelay * Math.pow(this.retry.backoffMultiplier, this.retry.count - 1),
        this.retry.maxDelay
      );
      break;
    case 'linear':
      delay = Math.min(this.retry.baseDelay * this.retry.count, this.retry.maxDelay);
      break;
    case 'fixed':
    default:
      delay = this.retry.baseDelay;
      break;
  }
  this.retry.nextRetryAt = new Date(Date.now() + delay);
  return this;
};

NotificationSchema.methods.updateDeliveryStatus = function(channel, status, metadata = {}) {
  if (!this.delivery[channel]) {
    this.delivery[channel] = {};
  }
  this.delivery[channel].status = status;
  const now = new Date();
  if (status === 'sent') {
    this.delivery[channel].sentAt = now;
  } else if (status === 'delivered') {
    this.delivery[channel].deliveredAt = now;
  } else if (status === 'failed') {
    this.delivery[channel].error = metadata.error;
    this.processing.lastError = {
      message: metadata.error,
      code: metadata.errorCode || 'DELIVERY_FAILED',
      timestamp: now
    };
  }
  Object.assign(this.delivery[channel], metadata);
  const allChannels = this.channels || [];
  const deliveredChannels = allChannels.filter(ch =>
    this.delivery[ch] && ['delivered', 'sent'].includes(this.delivery[ch].status)
  );
  if (deliveredChannels.length === allChannels.length) {
    this.status = 'delivered';
  } else if (deliveredChannels.length > 0) {
    this.status = 'sent';
  }
  return this;
};

NotificationSchema.methods.softDelete = async function(reason = 'user_request', deletedBy = null) {
  this.deletion.isDeleted = true;
  this.deletion.deletedAt = new Date();
  this.deletion.deletionReason = reason;
  if (deletedBy) {
    this.deletion.deletedBy = deletedBy;
  }
  this.compliance.auditLog.push({
    action: 'soft_deleted',
    userId: deletedBy,
    timestamp: new Date(),
    metadata: { reason }
  });
  await this.save();
  notificationEvents.emit('notification:deleted', {
    notificationId: this._id,
    userId: this.userId,
    reason
  });
  return this;
};

NotificationSchema.methods.archive = async function() {
  this.status = 'archived';
  this.compliance.auditLog.push({
    action: 'archived',
    timestamp: new Date()
  });
  await this.save();
  return this;
};

NotificationSchema.methods.calculateMetrics = function() {
  const channels = this.channels || [];
  let delivered = 0;
  let sent = 0;
  channels.forEach(channel => {
    if (this.delivery[channel]) {
      const status = this.delivery[channel].status;
      if (status === 'delivered') delivered++;
      if (['sent', 'delivered'].includes(status)) sent++;
    }
  });
  this.metrics.deliveryRate = channels.length > 0 ? delivered / channels.length : 0;
  if (this.interactions.seenCount > 0) {
    this.metrics.openRate = this.interactions.seenCount > 0 ? 1 : 0;
  }
  if (this.interactions.clickCount > 0) {
    this.metrics.clickRate = this.interactions.clickCount > 0 ? 1 : 0;
  }
  return this;
};

// Static methods
NotificationSchema.statics.findUnreadByUser = function(userId, options = {}) {
  const { limit = 50, skip = 0, type = null } = options;
  const query = {
    userId,
    'interactions.seen': false,
    'deletion.isDeleted': false,
    status: { $in: ['sent', 'delivered'] },
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: { $gt: new Date() } }
    ]
  };
  if (type) {
    query.type = type;
  }
  return this.find(query)
    .sort({ priority: 1, createdAt: -1 })
    .limit(limit)
    .skip(skip)
    .lean();
};

NotificationSchema.statics.findByUserAndFilters = function(userId, filters = {}) {
  const {
    type,
    subType,
    status,
    startDate,
    endDate,
    limit = 20,
    skip = 0,
    sortBy = 'createdAt',
    sortOrder = -1
  } = filters;
  const query = {
    userId,
    'deletion.isDeleted': false
  };
  if (type) query.type = type;
  if (subType) query.subType = subType;
  if (status) query.status = status;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }
  const sort = {};
  sort[sortBy] = sortOrder;
  return this.find(query)
    .sort(sort)
    .limit(limit)
    .skip(skip)
    .lean();
};

NotificationSchema.statics.findPendingForProcessing = function(limit = 100) {
  return this.find({
    status: { $in: ['pending', 'queued'] },
    'deletion.isDeleted': false,
    $or: [
      { 'scheduling.scheduledFor': { $exists: false } },
      { 'scheduling.scheduledFor': { $lte: new Date() } }
    ]
  })
  .sort({ priority: 1, createdAt: 1 })
  .limit(limit);
};

NotificationSchema.statics.findForRetry = function(limit = 50) {
  return this.find({
    status: 'failed',
    $expr: { $lt: ["$retry.count", "$retry.maxRetries"] },
    'retry.nextRetryAt': { $lte: new Date() },
    'deletion.isDeleted': false
  })
  .sort({ 'retry.nextRetryAt': 1 })
  .limit(limit);
};

NotificationSchema.statics.getAnalytics = function(filters = {}) {
  const {
    userId,
    startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    endDate = new Date(),
    groupBy = 'type'
  } = filters;
  const matchQuery = {
    createdAt: { $gte: startDate, $lte: endDate },
    'deletion.isDeleted': false
  };
  if (userId) matchQuery.userId = userId;
  const pipeline = [
    { $match: matchQuery },
    {
      $group: {
        _id: `$${groupBy}`,
        total: { $sum: 1 },
        seen: { $sum: { $cond: ['$interactions.seen', 1, 0] } },
        clicked: { $sum: { $cond: ['$interactions.clicked', 1, 0] } },
        dismissed: { $sum: { $cond: ['$interactions.dismissed', 1, 0] } },
        delivered: {
          $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] }
        },
        failed: {
          $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
        },
        avgProcessingTime: { $avg: '$processing.processingTime' },
        avgQueueTime: { $avg: '$processing.queueTime' },
        totalCost: { $sum: '$metrics.cost' },
        totalRevenue: { $sum: '$metrics.revenue' }
      }
    },
    {
      $addFields: {
        openRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$seen', '$total'] }, 0] },
        clickRate: { $cond: [{ $gt: ['$seen', 0] }, { $divide: ['$clicked', '$seen'] }, 0] },
        deliveryRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$delivered', '$total'] }, 0] },
        failureRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$failed', '$total'] }, 0] }
      }
    },
    { $sort: { total: -1 } }
  ];
  return this.aggregate(pipeline);
};

NotificationSchema.statics.bulkMarkAsSeen = function(userId, notificationIds) {
  const updateDoc = {
    $set: {
      'interactions.seen': true,
      'interactions.seenAt': new Date()
    },
    $inc: {
      'interactions.seenCount': 1
    },
    $push: {
      'compliance.auditLog': {
        action: 'bulk_marked_seen',
        timestamp: new Date()
      }
    }
  };
  return this.updateMany(
    {
      userId,
      _id: { $in: notificationIds },
      'interactions.seen': false,
      'deletion.isDeleted': false
    },
    updateDoc
  );
};

NotificationSchema.statics.bulkDelete = function(userId, notificationIds, deletedBy = null) {
  const updateDoc = {
    $set: {
      'deletion.isDeleted': true,
      'deletion.deletedAt': new Date(),
      'deletion.deletionReason': 'bulk_delete'
    },
    $push: {
      'compliance.auditLog': {
        action: 'bulk_deleted',
        userId: deletedBy,
        timestamp: new Date()
      }
    }
  };
  if (deletedBy) {
    updateDoc.$set['deletion.deletedBy'] = deletedBy;
  }
  return this.updateMany(
    {
      userId,
      _id: { $in: notificationIds },
      'deletion.isDeleted': false
    },
    updateDoc
  );
};

NotificationSchema.statics.findDuplicates = function(userId, type, data, timeWindow = 60000) {
  const timeThreshold = new Date(Date.now() - timeWindow);
  return this.find({
    userId,
    type,
    'data.correlationId': data.correlationId,
    createdAt: { $gte: timeThreshold },
    'deletion.isDeleted': false
  });
};

NotificationSchema.statics.getUnreadCount = function(userId, type = null) {
  const query = {
    userId,
    'interactions.seen': false,
    'deletion.isDeleted': false,
    status: { $in: ['sent', 'delivered'] }
  };
  if (type) {
    query.type = type;
  }
  return this.countDocuments(query);
};

NotificationSchema.statics.searchNotifications = function(userId, searchTerm, options = {}) {
  const { limit = 20, skip = 0 } = options;
  return this.find({
    userId,
    'deletion.isDeleted': false,
    $text: { $search: searchTerm }
  }, {
    score: { $meta: 'textScore' }
  })
  .sort({ score: { $meta: 'textScore' }, createdAt: -1 })
  .limit(limit)
  .skip(skip);
};

NotificationSchema.statics.cleanupExpired = function() {
  return this.updateMany(
    {
      expiresAt: { $lte: new Date() },
      status: { $nin: ['expired', 'archived'] },
      'deletion.isDeleted': false
    },
    {
      $set: {
        status: 'expired',
        'processing.completedAt': new Date()
      },
      $push: {
        'compliance.auditLog': {
          action: 'auto_expired',
          timestamp: new Date()
        }
      }
    }
  );
};

// Pre-save middleware
NotificationSchema.pre('save', function(next) {
  if (!this.expiresAt) {
    const retentionDays = this.data?.dataRetentionDays || 90;
    this.expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
  }
  if (this.isNew && this.channels) {
    this.channels.forEach(channel => {
      if (!this.delivery[channel]) {
        this.delivery[channel] = { status: 'pending' };
      }
    });
  }
  if (this.isNew) {
    this.processing.queuedAt = new Date();
  }
  this.calculateMetrics();
  if (this.compliance.consentRequired && !this.compliance.consentGiven) {
    return next(new Error('Consent required but not given'));
  }
  if (this.scheduling?.scheduledFor && this.scheduling.scheduledFor <= new Date()) {
    this.scheduling.scheduledFor = undefined;
  }
  if (this.isNew) {
    this.compliance.auditLog.push({
      action: 'created',
      timestamp: new Date(),
      metadata: {
        channels: this.channels,
        type: this.type,
        priority: this.priority
      }
    });
  }
  next();
});

// Pre-validate middleware
NotificationSchema.pre('validate', function(next) {
  if (!this.channels || this.channels.length === 0) {
    return next(new Error('At least one delivery channel must be specified'));
  }
  const uniqueChannels = new Set(this.channels);
  if (this.channels.length !== uniqueChannels.size) {
    return next(new Error('Channels must be unique'));
  }
  if (this.scheduling?.recurring?.enabled) {
    if (!this.scheduling.recurring.pattern) {
      return next(new Error('Recurring pattern must be specified when recurring is enabled'));
    }
  }
  if (this.data?.actions) {
    const actionIds = this.data.actions.map(a => a.id);
    const uniqueIds = new Set(actionIds);
    if (actionIds.length !== uniqueIds.size) {
      return next(new Error('Action IDs must be unique'));
    }
  }
  next();
});

// Post-save middleware
NotificationSchema.post('save', async function(doc, next) {
  try {
    if (doc.isNew && !doc.deletion.isDeleted) {
      notificationEvents.emit('notification:created', {
        notificationId: doc._id,
        userId: doc.userId,
        type: doc.type,
        priority: doc.priority,
        channels: doc.channels
      });
    }
    if (doc.isModified('status')) {
      notificationEvents.emit('notification:status_changed', {
        notificationId: doc._id,
        userId: doc.userId,
        oldStatus: doc.$locals.oldStatus,
        newStatus: doc.status
      });
    }
    next();
  } catch (error) {
    next(error);
  }
});

// Pre-remove middleware
NotificationSchema.pre('remove', function(next) {
  this.compliance.auditLog.push({
    action: 'hard_deleted',
    timestamp: new Date()
  });
  notificationEvents.emit('notification:hard_deleted', {
    notificationId: this._id,
    userId: this.userId
  });
  next();
});

// Error handling middleware
NotificationSchema.post('save', function(error, doc, next) {
  if (error.name === 'MongoError' && error.code === 11000) {
    const field = Object.keys(error.keyPattern)[0];
    next(new Error(`Duplicate value for ${field}`));
  } else {
    next(error);
  }
});

// Performance monitoring
NotificationSchema.pre('find', function(next) {
  this.startTime = Date.now();
  next();
});

NotificationSchema.post('find', function() {
  const executionTime = Date.now() - (this.startTime || Date.now());
  if (executionTime > 1000) {
    console.warn(`Slow notification query detected: ${executionTime}ms`, {
      query: this.getQuery(),
      executionTime
    });
  }
});

// Create and export the model
const Notification = model('Notification', NotificationSchema);
Notification.createIndexes().catch(console.error);
export default Notification;