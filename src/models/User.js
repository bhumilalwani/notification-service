import mongoose from 'mongoose';
import validator from 'validator';
import { EventEmitter } from 'events';
import winston from 'winston';
import { notificationEvents } from './Notification.js'; // Import from Notification model

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
    new winston.transports.File({ filename: 'logs/notificationUser.log' })
  ]
});

// Event emitter for user notification events
export const userNotificationEvents = new EventEmitter();

// Sub-schema for web push subscriptions
const PushSubscriptionSchema = new Schema({
  endpoint: { type: String, required: true, maxlength: 500 },
  keys: {
    p256dh: { type: String, required: true, maxlength: 200 },
    auth: { type: String, required: true, maxlength: 200 }
  },
  platform: { type: String, enum: ['web', 'ios', 'android'], default: 'web' },
  userAgent: { type: String, maxlength: 500 },
  browser: { type: String, maxlength: 50 },
  os: { type: String, maxlength: 50 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: Date.now }
});

// Sub-schema for mobile devices
const DeviceSchema = new Schema({
  deviceToken: { type: String, required: true, maxlength: 200 },
  platform: { type: String, enum: ['ios', 'android'], required: true },
  appVersion: { type: String, maxlength: 20 },
  isActive: { type: Boolean, default: true },
  lastActive: { type: Date, default: Date.now }
});

// Sub-schema for notification preferences
const NotificationPreferenceSchema = new Schema({
  type: {
    type: String,
    enum: [
      'general', 'security', 'marketing', 'system', 'urgent', 'promotional', 'reminder',
      'social', 'payment', 'order', 'message', 'alert', 'like', 'comment', 'follow',
      'connection_request', 'job_alert', 'mention', 'share', 'endorsement', 'profile_view',
      'birthday', 'work_anniversary', 'group_invite', 'event_invite', 'content_update'
    ],
    required: true
  },
  channels: [{
    type: String,
    enum: ['email', 'push', 'sms', 'mobile', 'in-app', 'slack', 'teams'],
    required: true
  }],
  enabled: { type: Boolean, default: true },
  frequency: {
    type: String,
    enum: ['immediate', 'hourly', 'daily', 'weekly', 'never'],
    default: 'immediate'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  }
});

// Sub-schema for consents
const ConsentSchema = new Schema({
  type: {
    type: String,
    enum: ['marketing', 'notifications', 'analytics', 'data_processing'],
    required: true
  },
  given: { type: Boolean, default: false },
  consentId: { type: String, maxlength: 100 },
  timestamp: { type: Date, default: Date.now },
  source: { type: String, maxlength: 100 },
  ipAddress: { type: String, maxlength: 45 }
});

const UserSchema = new Schema({
  userId: {
    type: String,
    unique: true,
    required: true,
    index: true,
    maxlength: 50,
    validate: {
      validator: function(v) {
        return /^[a-zA-Z0-9_-]+$/.test(v);
      },
      message: 'UserId must contain only alphanumeric characters, underscores, and hyphens'
    }
  },
  contact: {
    email: {
      type: String,
      lowercase: true,
      trim: true,
      required: false,
      maxlength: 100,
      validate: {
        validator: function(v) {
          return !v || validator.isEmail(v);
        },
        message: 'Invalid email format'
      },
      index: { unique: true, sparse: true }
    },
    phone: {
      type: String,
      maxlength: 20,
      validate: {
        validator: function(v) {
          return !v || validator.isMobilePhone(v, 'any', { strictMode: false });
        },
        message: 'Invalid phone number format'
      },
      index: { sparse: true }
    },
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date }
  },
  profile: {
    firstName: { type: String, maxlength: 50, trim: true },
    lastName: { type: String, maxlength: 50, trim: true },
    displayName: { type: String, maxlength: 100, trim: true },
    avatar: { type: String, maxlength: 500 },
    jobTitle: { type: String, maxlength: 100 }, // LinkedIn-specific
    company: { type: String, maxlength: 100 }, // LinkedIn-specific
    connectionCount: { type: Number, default: 0, min: 0 }, // LinkedIn-specific
    language: {
      type: String,
      default: 'en',
      maxlength: 10,
      validate: {
        validator: validator.isLocale,
        message: 'Invalid language code'
      }
    },
    locale: {
      type: String,
      default: 'en-US',
      maxlength: 10,
      validate: {
        validator: validator.isLocale,
        message: 'Invalid locale code'
      }
    },
    timezone: {
      type: String,
      default: 'UTC',
      maxlength: 50
    },
    country: {
      type: String,
      maxlength: 2,
      validate: {
        validator: validator.isISO31661Alpha2,
        message: 'Invalid country code'
      }
    }
  },
  notificationPreferences: [NotificationPreferenceSchema],
  quietHours: {
    enabled: { type: Boolean, default: false },
    startTime: {
      type: String,
      maxlength: 5,
      validate: {
        validator: function(v) {
          return !this.quietHours.enabled || (v && /^\d{2}:\d{2}$/.test(v));
        },
        message: 'Invalid startTime format (HH:MM) or missing when quietHours.enabled is true'
      }
    },
    endTime: {
      type: String,
      maxlength: 5,
      validate: {
        validator: function(v) {
          return !this.quietHours.enabled || (v && /^\d{2}:\d{2}$/.test(v));
        },
        message: 'Invalid endTime format (HH:MM) or missing when quietHours.enabled is true'
      }
    },
    timezone: { type: String, default: 'UTC', maxlength: 50 },
    allowCritical: { type: Boolean, default: true },
    weekendsOnly: { type: Boolean, default: false }
  },
  frequencyLimits: {
    maxPerHour: { type: Number, default: 10, min: 1, max: 100 },
    maxPerDay: { type: Number, default: 50, min: 1, max: 1000 },
    digestMode: { type: Boolean, default: false },
    digestFrequency: {
      type: String,
      enum: ['hourly', 'daily', 'weekly'],
      default: 'daily'
    }
  },
  pushSubscriptions: [PushSubscriptionSchema],
  devices: [DeviceSchema],
  consents: [ConsentSchema],
  analytics: {
    totalNotificationsReceived: { type: Number, default: 0 },
    totalNotificationsSeen: { type: Number, default: 0 },
    totalNotificationsClicked: { type: Number, default: 0 },
    totalNotificationsDismissed: { type: Number, default: 0 },
    engagementScore: { type: Number, default: 50, min: 0, max: 100 },
    lastEngagementAt: { type: Date },
    channelMetrics: {
      email: {
        sent: { type: Number, default: 0 },
        delivered: { type: Number, default: 0 },
        opened: { type: Number, default: 0 },
        clicked: { type: Number, default: 0 },
        bounced: { type: Number, default: 0 }
      },
      push: {
        sent: { type: Number, default: 0 },
        delivered: { type: Number, default: 0 },
        clicked: { type: Number, default: 0 },
        dismissed: { type: Number, default: 0 }
      },
      sms: {
        sent: { type: Number, default: 0 },
        delivered: { type: Number, default: 0 },
        failed: { type: Number, default: 0 }
      },
      mobile: {
        sent: { type: Number, default: 0 },
        delivered: { type: Number, default: 0 },
        clicked: { type: Number, default: 0 },
        dismissed: { type: Number, default: 0 }
      },
      inApp: {
        sent: { type: Number, default: 0 },
        delivered: { type: Number, default: 0 },
        clicked: { type: Number, default: 0 },
        dismissed: { type: Number, default: 0 }
      }
    },
    preferencesUpdatedAt: { type: Date },
    preferencesUpdateCount: { type: Number, default: 0 }
  },
  experiments: {
    activeExperiments: [{
      experimentId: { type: String, required: true, maxlength: 50 },
      variant: { type: String, required: true, maxlength: 50 },
      enrolledAt: { type: Date, default: Date.now }
    }],
    testGroups: [{ type: String, maxlength: 50 }]
  },
  integrations: {
    crmId: { type: String, maxlength: 100 },
    analyticsIds: {
      mixpanel: { type: String, maxlength: 100 },
      amplitude: { type: String, maxlength: 100 },
      segment: { type: String, maxlength: 100 }
    },
    externalIds: {
      sendgrid: { type: String, maxlength: 100 },
      twilio: { type: String, maxlength: 100 },
      firebase: { type: String, maxlength: 100 }
    }
  },
  status: {
    isActive: { type: Boolean, default: true },
    isPaused: { type: Boolean, default: false },
    pausedUntil: { type: Date },
    pauseReason: { type: String, maxlength: 200 },
    emailBounced: { type: Boolean, default: false },
    phoneInvalid: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: Date.now },
    lastNotificationAt: { type: Date }
  },
  rateLimiting: {
    currentHourCount: { type: Number, default: 0 },
    currentDayCount: { type: Number, default: 0 },
    lastHourReset: { type: Date, default: Date.now },
    lastDayReset: { type: Date, default: Date.now },
    isBlocked: { type: Boolean, default: false },
    blockedUntil: { type: Date }
  },
  deletion: {
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, index: { sparse: true } },
    deletedBy: { type: String, maxlength: 50 },
    deletionReason: {
      type: String,
      enum: ['user_request', 'gdpr', 'admin', 'automated'],
      maxlength: 50
    }
  },
  compliance: {
    gdprCompliant: { type: Boolean, default: true },
    ccpaCompliant: { type: Boolean, default: true },
    coppaCompliant: { type: Boolean, default: false },
    dataRetentionDays: { type: Number, default: 2555, min: 1 },
    auditLog: [{
      action: { type: String, required: true, maxlength: 100 },
      field: { type: String, maxlength: 100 },
      oldValue: { type: Schema.Types.Mixed },
      newValue: { type: Schema.Types.Mixed },
      timestamp: { type: Date, default: Date.now },
      ipAddress: { type: String, maxlength: 45 },
      userAgent: { type: String, maxlength: 500 }
    }]
  }
}, {
  timestamps: true,
  versionKey: false,
  minimize: false,
  collection: 'notification_users',
  read: 'secondaryPreferred'
});

// Indexes
UserSchema.index({ 'profile.country': 1, 'profile.language': 1 });
UserSchema.index({ 'status.isActive': 1, 'status.isPaused': 1 });
UserSchema.index({ 'analytics.engagementScore': -1 });
UserSchema.index({ 'status.lastSeenAt': -1 });
UserSchema.index({ 'pushSubscriptions.isActive': 1 });
UserSchema.index({ 'notificationPreferences.type': 1, 'notificationPreferences.enabled': 1 });
UserSchema.index({ 'consents.type': 1, 'consents.given': 1 });
UserSchema.index({
  'profile.firstName': 'text',
  'profile.lastName': 'text',
  'profile.displayName': 'text',
  'contact.email': 'text'
});

// Virtual fields
UserSchema.virtual('fullName').get(function() {
  return this.profile.firstName && this.profile.lastName
    ? `${this.profile.firstName} ${this.profile.lastName}`
    : this.profile.displayName || this.contact.email || this.userId;
});

UserSchema.virtual('isEngaged').get(function() {
  return this.analytics.engagementScore > 50 && this.status.isActive;
});

UserSchema.virtual('daysSinceLastSeen').get(function() {
  if (!this.status.lastSeenAt) return null;
  return Math.floor((Date.now() - this.status.lastSeenAt) / (1000 * 60 * 60 * 24));
});

UserSchema.virtual('activePushSubscriptions').get(function() {
  return this.pushSubscriptions.filter(sub => sub.isActive);
});

UserSchema.virtual('activeDevices').get(function() {
  return this.devices.filter(device => device.isActive);
});

// Instance methods
UserSchema.methods.updateNotificationPreference = async function(type, channels, enabled, frequency, priority, metadata = {}) {
  try {
    const pref = this.notificationPreferences.find(p => p.type === type);
    const oldPref = pref ? JSON.parse(JSON.stringify(pref)) : null;
    if (pref) {
      if (channels) pref.channels = [...new Set(channels)];
      if (typeof enabled === 'boolean') pref.enabled = enabled;
      if (frequency) pref.frequency = frequency;
      if (priority) pref.priority = priority;
    } else {
      this.notificationPreferences.push({
        type,
        channels: [...new Set(channels)],
        enabled,
        frequency: frequency || 'immediate',
        priority: priority || 'medium'
      });
    }
    this.analytics.preferencesUpdatedAt = new Date();
    this.analytics.preferencesUpdateCount += 1;
    this.compliance.auditLog.push({
      action: 'notification_preference_updated',
      field: 'notificationPreferences',
      oldValue: oldPref,
      newValue: pref || { type, channels, enabled, frequency, priority },
      timestamp: new Date(),
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent
    });
    await this.save();
    userNotificationEvents.emit('notification_preference_updated', {
      userId: this.userId,
      type,
      channels,
      enabled,
      frequency,
      priority
    });
    logger.info('Notification preference updated', { userId: this.userId, type, channels });
    return this;
  } catch (error) {
    logger.error('Failed to update notification preference', { userId: this.userId, type, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.addPushSubscription = async function(subscription, metadata = {}) {
  try {
    this.pushSubscriptions = this.pushSubscriptions.filter(sub => sub.endpoint !== subscription.endpoint);
    const newSub = {
      ...subscription,
      userAgent: metadata.userAgent,
      browser: metadata.browser,
      os: metadata.os,
      isActive: true,
      createdAt: new Date(),
      lastUsedAt: new Date()
    };
    this.pushSubscriptions.push(newSub);
    this.compliance.auditLog.push({
      action: 'push_subscription_added',
      field: 'pushSubscriptions',
      newValue: newSub,
      timestamp: new Date(),
      ipAddress: metadata.ipAddress
    });
    await this.save();
    userNotificationEvents.emit('push_subscription_added', {
      userId: this.userId,
      subscription: newSub
    });
    logger.info('Push subscription added', { userId: this.userId, endpoint: newSub.endpoint });
    return this;
  } catch (error) {
    logger.error('Failed to add push subscription', { userId: this.userId, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.removePushSubscription = async function(endpoint) {
  try {
    const oldCount = this.pushSubscriptions.length;
    this.pushSubscriptions = this.pushSubscriptions.filter(sub => sub.endpoint !== endpoint);
    if (this.pushSubscriptions.length < oldCount) {
      this.compliance.auditLog.push({
        action: 'push_subscription_removed',
        field: 'pushSubscriptions',
        oldValue: endpoint,
        timestamp: new Date()
      });
      await this.save();
      userNotificationEvents.emit('push_subscription_removed', {
        userId: this.userId,
        endpoint
      });
      logger.info('Push subscription removed', { userId: this.userId, endpoint });
    }
    return this;
  } catch (error) {
    logger.error('Failed to remove push subscription', { userId: this.userId, endpoint, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.addDevice = async function(device, metadata = {}) {
  try {
    const exists = this.devices.some(d => d.deviceToken === device.deviceToken && d.platform === device.platform);
    if (!exists) {
      this.devices.push(device);
      this.compliance.auditLog.push({
        action: 'device_added',
        field: 'devices',
        newValue: device,
        timestamp: new Date(),
        ipAddress: metadata.ipAddress
      });
      await this.save();
      userNotificationEvents.emit('device_added', {
        userId: this.userId,
        deviceToken: device.deviceToken,
        platform: device.platform
      });
      logger.info('Device added', { userId: this.userId, deviceToken: device.deviceToken, platform: device.platform });
    }
    return this;
  } catch (error) {
    logger.error('Failed to add device', { userId: this.userId, deviceToken: device.deviceToken, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.removeDevice = async function(deviceToken, platform) {
  try {
    const oldCount = this.devices.length;
    this.devices = this.devices.filter(d => d.deviceToken !== deviceToken || d.platform !== platform);
    if (this.devices.length < oldCount) {
      this.compliance.auditLog.push({
        action: 'device_removed',
        field: 'devices',
        oldValue: { deviceToken, platform },
        timestamp: new Date()
      });
      await this.save();
      userNotificationEvents.emit('device_removed', {
        userId: this.userId,
        deviceToken,
        platform
      });
      logger.info('Device removed', { userId: this.userId, deviceToken, platform });
    }
    return this;
  } catch (error) {
    logger.error('Failed to remove device', { userId: this.userId, deviceToken, platform, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.grantConsent = async function(consentType, consentId, metadata = {}) {
  try {
    const consent = this.consents.find(c => c.type === consentType);
    const oldConsent = consent ? JSON.parse(JSON.stringify(consent)) : null;
    if (consent) {
      consent.given = true;
      consent.timestamp = new Date();
      consent.consentId = consentId;
      consent.source = metadata.source;
      consent.ipAddress = metadata.ipAddress;
    } else {
      this.consents.push({ type: consentType, given: true, consentId, source: metadata.source, ipAddress: metadata.ipAddress });
    }
    this.compliance.auditLog.push({
      action: 'consent_granted',
      field: 'consents',
      oldValue: oldConsent,
      newValue: consent || { type: consentType, given: true, consentId },
      timestamp: new Date(),
      ipAddress: metadata.ipAddress
    });
    await this.save();
    userNotificationEvents.emit('consent_granted', {
      userId: this.userId,
      consentType,
      consentId
    });
    logger.info('Consent granted', { userId: this.userId, consentType, consentId });
    return this;
  } catch (error) {
    logger.error('Failed to grant consent', { userId: this.userId, consentType, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.revokeConsent = async function(consentType, metadata = {}) {
  try {
    const consent = this.consents.find(c => c.type === consentType);
    if (consent) {
      const oldConsent = JSON.parse(JSON.stringify(consent));
      consent.given = false;
      consent.timestamp = new Date();
      consent.ipAddress = metadata.ipAddress;
      this.compliance.auditLog.push({
        action: 'consent_revoked',
        field: 'consents',
        oldValue: oldConsent,
        newValue: consent,
        timestamp: new Date(),
        ipAddress: metadata.ipAddress
      });
      await this.save();
      userNotificationEvents.emit('consent_revoked', {
        userId: this.userId,
        consentType
      });
      logger.info('Consent revoked', { userId: this.userId, consentType });
    }
    return this;
  } catch (error) {
    logger.error('Failed to revoke consent', { userId: this.userId, consentType, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.recordNotificationReceived = async function(channel = 'push') {
  try {
    if (this.analytics.channelMetrics[channel]) {
      this.analytics.totalNotificationsReceived += 1;
      this.status.lastNotificationAt = new Date();
      this.analytics.channelMetrics[channel].sent += 1;
      await this.incrementRateLimit();
      await this.save();
      logger.info('Notification received recorded', { userId: this.userId, channel });
    }
    return this;
  } catch (error) {
    logger.error('Failed to record notification received', { userId: this.userId, channel, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.recordNotificationEngagement = async function(action, channel = 'push') {
  try {
    if (this.analytics.channelMetrics[channel]) {
      this.analytics.lastEngagementAt = new Date();
      switch (action) {
        case 'seen':
          this.analytics.totalNotificationsSeen += 1;
          this.analytics.channelMetrics[channel].opened += 1;
          break;
        case 'clicked':
          this.analytics.totalNotificationsClicked += 1;
          this.analytics.channelMetrics[channel].clicked += 1;
          break;
        case 'dismissed':
          this.analytics.totalNotificationsDismissed += 1;
          this.analytics.channelMetrics[channel].dismissed += 1;
          break;
      }
      this.calculateEngagementScore();
      await this.save();
      logger.info('Notification engagement recorded', { userId: this.userId, action, channel });
    }
    return this;
  } catch (error) {
    logger.error('Failed to record notification engagement', { userId: this.userId, action, channel, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.calculateEngagementScore = function() {
  const {
    totalNotificationsReceived,
    totalNotificationsSeen,
    totalNotificationsClicked,
    totalNotificationsDismissed
  } = this.analytics;
  if (totalNotificationsReceived === 0) {
    this.analytics.engagementScore = 50;
    return this;
  }
  const openRate = totalNotificationsSeen / totalNotificationsReceived;
  const clickRate = totalNotificationsSeen > 0 ? totalNotificationsClicked / totalNotificationsSeen : 0;
  const dismissRate = totalNotificationsReceived > 0 ? totalNotificationsDismissed / totalNotificationsReceived : 0;
  const daysSinceLastSeen = this.daysSinceLastSeen || 0;
  let score = 0;
  score += openRate * 35; // 35% weight
  score += clickRate * 35; // 35% weight
  score += Math.max(0, 20 - (daysSinceLastSeen * 0.5)); // 20% weight
  score -= dismissRate * 10; // 10% penalty for dismissals
  this.analytics.engagementScore = Math.round(Math.min(100, Math.max(0, score)));
  return this;
};

UserSchema.methods.pauseNotifications = async function(duration, reason = '', metadata = {}) {
  try {
    this.status.isPaused = true;
    this.status.pauseReason = reason;
    if (duration) {
      this.status.pausedUntil = new Date(Date.now() + duration);
    }
    this.compliance.auditLog.push({
      action: 'notifications_paused',
      field: 'status.isPaused',
      newValue: true,
      timestamp: new Date(),
      ipAddress: metadata.ipAddress
    });
    await this.save();
    userNotificationEvents.emit('notifications_paused', {
      userId: this.userId,
      reason,
      until: this.status.pausedUntil
    });
    logger.info('Notifications paused', { userId: this.userId, reason, until: this.status.pausedUntil });
    return this;
  } catch (error) {
    logger.error('Failed to pause notifications', { userId: this.userId, reason, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.resumeNotifications = async function(metadata = {}) {
  try {
    this.status.isPaused = false;
    this.status.pausedUntil = null;
    this.status.pauseReason = '';
    this.compliance.auditLog.push({
      action: 'notifications_resumed',
      field: 'status.isPaused',
      newValue: false,
      timestamp: new Date(),
      ipAddress: metadata.ipAddress
    });
    await this.save();
    userNotificationEvents.emit('notifications_resumed', {
      userId: this.userId
    });
    logger.info('Notifications resumed', { userId: this.userId });
    return this;
  } catch (error) {
    logger.error('Failed to resume notifications', { userId: this.userId, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.checkRateLimit = function() {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (this.rateLimiting.lastHourReset < hourAgo) {
    this.rateLimiting.currentHourCount = 0;
    this.rateLimiting.lastHourReset = now;
  }
  if (this.rateLimiting.lastDayReset < dayAgo) {
    this.rateLimiting.currentDayCount = 0;
    this.rateLimiting.lastDayReset = now;
  }
  if (this.rateLimiting.isBlocked && this.rateLimiting.blockedUntil > now) {
    return { allowed: false, reason: 'blocked', until: this.rateLimiting.blockedUntil };
  }
  const maxPerHour = this.frequencyLimits.maxPerHour;
  const maxPerDay = this.frequencyLimits.maxPerDay;
  if (this.rateLimiting.currentHourCount >= maxPerHour) {
    return { allowed: false, reason: 'hourly_limit', limit: maxPerHour };
  }
  if (this.rateLimiting.currentDayCount >= maxPerDay) {
    return { allowed: false, reason: 'daily_limit', limit: maxPerDay };
  }
  return { allowed: true };
};

UserSchema.methods.incrementRateLimit = async function() {
  try {
    this.rateLimiting.currentHourCount += 1;
    this.rateLimiting.currentDayCount += 1;
    await this.save();
    logger.info('Rate limit incremented', { userId: this.userId, hourCount: this.rateLimiting.currentHourCount, dayCount: this.rateLimiting.currentDayCount });
  } catch (error) {
    logger.error('Failed to increment rate limit', { userId: this.userId, error: error?.stack });
    throw error;
  }
};

UserSchema.methods.canReceiveNotification = function(type, channel, priority = 'medium') {

console.log('canReceiveNotification check:', {
  type: payload.type,
  channel: 'email',
  priority: payload.priority,
  pref: user.notificationPreferences.find(p => p.type === payload.type),
  status: user.status,
  quietHours: user.quietHours
});


  if (!this.status.isActive || this.status.isPaused) {
    return priority === 'critical' && this.quietHours.allowCritical;
  }
  const pref = this.notificationPreferences.find(p => p.type === type);
  if (!pref || !pref.enabled || !pref.channels.includes(channel)) {
    return false;
  }
  if (this.quietHours.enabled && priority !== 'critical') {
    const now = new Date();
    const [startHour, startMinute] = this.quietHours.startTime.split(':').map(Number);
    const [endHour, endMinute] = this.quietHours.endTime.split(':').map(Number);
    const nowHours = now.getHours();
    const nowMinutes = now.getMinutes();
    const isQuietHour = (startHour < endHour)
      ? (nowHours > startHour || (nowHours === startHour && nowMinutes >= startMinute)) &&
        (nowHours < endHour || (nowHours === endHour && nowMinutes <= endMinute))
      : (nowHours > startHour || (nowHours === startHour && nowMinutes >= startMinute)) ||
        (nowHours < endHour || (nowHours === endHour && nowMinutes <= endMinute));
    if (isQuietHour && (!this.quietHours.allowCritical || priority !== 'critical')) {
      return false;
    }
  }
  const consentRequired = ['marketing'].includes(type);
  if (consentRequired) {
    const consent = this.consents.find(c => c.type === 'notifications' || c.type === type);
    if (!consent || !consent.given) return false;
  }
  return true;
};

UserSchema.methods.softDelete = async function(reason = 'user_request', deletedBy = null, metadata = {}) {
  try {
    this.deletion.isDeleted = true;
    this.deletion.deletedAt = new Date();
    this.deletion.deletionReason = reason;
    if (deletedBy) this.deletion.deletedBy = deletedBy;
    this.compliance.auditLog.push({
      action: 'soft_deleted',
      field: 'deletion',
      newValue: { reason, deletedBy },
      timestamp: new Date(),
      ipAddress: metadata.ipAddress
    });
    await this.save();
    userNotificationEvents.emit('user_deleted', {
      userId: this.userId,
      reason
    });
    logger.info('User soft deleted', { userId: this.userId, reason });
    return this;
  } catch (error) {
    logger.error('Failed to soft delete user', { userId: this.userId, reason, error: error?.stack });
    throw error;
  }
};

// Static methods
UserSchema.statics.findByEmail = function(email) {
  return this.findOne({ 'contact.email': email.toLowerCase(), 'deletion.isDeleted': false });
};

UserSchema.statics.findActiveUsers = function(limit = 100) {
  return this.find({
    'status.isActive': true,
    'status.isPaused': false,
    'deletion.isDeleted': false
  }).limit(limit).lean();
};

UserSchema.statics.findHighEngagementUsers = function(minScore = 70, limit = 100) {
  return this.find({
    'analytics.engagementScore': { $gte: minScore },
    'status.isActive': true,
    'deletion.isDeleted': false
  })
    .sort({ 'analytics.engagementScore': -1 })
    .limit(limit)
    .lean();
};

UserSchema.statics.findUsersForDigest = function(frequency = 'daily') {
  return this.find({
    'frequencyLimits.digestMode': true,
    'frequencyLimits.digestFrequency': frequency,
    'status.isActive': true,
    'status.isPaused': false,
    'deletion.isDeleted': false
  }).lean();
};

UserSchema.statics.findByNotificationType = function(type, channel, enabled = true) {
  return this.find({
    'notificationPreferences.type': type,
    'notificationPreferences.channels': channel,
    'notificationPreferences.enabled': enabled,
    'status.isActive': true,
    'deletion.isDeleted': false
  }).lean();
};

UserSchema.statics.findByConsent = function(consentType, given = true) {
  return this.find({
    'consents.type': consentType,
    'consents.given': given,
    'deletion.isDeleted': false
  }).lean();
};

UserSchema.statics.updateEngagementScores = async function() {
  try {
    const users = await this.find({
      'status.isActive': true,
      'analytics.totalNotificationsReceived': { $gt: 0 },
      'deletion.isDeleted': false
    });
    for (const user of users) {
      user.calculateEngagementScore();
      await user.save();
    }
    logger.info('Engagement scores updated', { count: users.length });
    return users.length;
  } catch (error) {
    logger.error('Failed to update engagement scores', { error: error?.stack });
    throw error;
  }
};

// Pre-save middleware
UserSchema.pre('save', function(next) {
  if (this.isModified('analytics')) {
    this.calculateEngagementScore();
  }
  if (this.isModified('status.isActive') && this.status.isActive) {
    this.status.lastSeenAt = new Date();
  }
  if (this.status.isPaused && this.status.pausedUntil && this.status.pausedUntil <= new Date()) {
    this.status.isPaused = false;
    this.status.pausedUntil = null;
    this.status.pauseReason = '';
  }
  this.notificationPreferences.forEach(pref => {
    pref.channels = [...new Set(pref.channels)];
  });
  next();
});

// Pre-validate middleware
UserSchema.pre('validate', function(next) {
  if (this.notificationPreferences.length > 0) {
    const types = this.notificationPreferences.map(p => p.type);
    const uniqueTypes = new Set(types);
    if (types.length !== uniqueTypes.size) {
      return next(new Error('Notification preference types must be unique'));
    }
  }
  if (this.consents.length > 0) {
    const consentTypes = this.consents.map(c => c.type);
    const uniqueConsentTypes = new Set(consentTypes);
    if (consentTypes.length !== uniqueConsentTypes.size) {
      return next(new Error('Consent types must be unique'));
    }
  }
  next();
});

// Post-save middleware
UserSchema.post('save', async function(doc, next) {
  try {
    if (doc.isNew) {
      userNotificationEvents.emit('user_created', {
        userId: doc.userId,
        email: doc.contact.email
      });
      logger.info('User created', { userId: doc.userId, email: doc.contact.email });
    }
    if (doc.isModified('notificationPreferences')) {
      userNotificationEvents.emit('notification_preferences_changed', {
        userId: doc.userId,
        preferences: doc.notificationPreferences
      });
      logger.info('Notification preferences changed', { userId: doc.userId });
    }
    if (doc.isModified('status.isActive')) {
      userNotificationEvents.emit('status_changed', {
        userId: doc.userId,
        isActive: doc.status.isActive
      });
      logger.info('User status changed', { userId: doc.userId, isActive: doc.status.isActive });
    }
    next();
  } catch (error) {
    logger.error('Post-save middleware error', { userId: doc.userId, error: error?.stack });
    next(error);
  }
});

// Error handling
UserSchema.post('save', function(error, doc, next) {
  if (error.name === 'MongoServerError' && error.code === 11000) {
    const field = Object.keys(error.keyPattern)[0];
    logger.error('Duplicate value error', { userId: doc.userId, field, error: error?.stack });
    next(new Error(`Duplicate value for ${field}`));
  } else {
    logger.error('Save error', { userId: doc.userId, error: error?.stack });
    next(error);
  }
});

// Create and export the model
const NotificationUser = model('NotificationUser', UserSchema);
NotificationUser.createIndexes().catch(err => logger.error('Index creation failed', { error: err?.stack }));
export default NotificationUser;
// export { userNotificationEvents };