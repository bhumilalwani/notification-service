import nodemailer from 'nodemailer';
import { EventEmitter } from 'events';
import NotificationUser from '../../models/User.js';
import DeviceToken from '../../models/DeviceToken.js';
import webPush from 'web-push';


// Firebase service - proper async loading
let firebaseAdminService = null;
let firebaseLoadPromise = null;

// Function to load Firebase
async function loadFirebaseService() {
  if (firebaseLoadPromise) {
    return firebaseLoadPromise;
  }
 
  firebaseLoadPromise = (async () => {
    try {
      console.log('Loading Firebase Admin module...');
      const firebaseModule = await import('../firebase/firebaseAdmin.js');
      firebaseAdminService = firebaseModule.default;
     
      // Wait a bit for Firebase to initialize
      await new Promise(resolve => setTimeout(resolve, 1000));
     
      if (firebaseAdminService && firebaseAdminService.getHealth) {
        const health = firebaseAdminService.getHealth();
        console.log('Firebase loaded successfully:', health.initialized);
      }
     
      return firebaseAdminService;
    } catch (error) {
      console.warn('Firebase Admin not available:', error.message);
      return null;
    }
  })();
 
  return firebaseLoadPromise;
}

// Start loading Firebase immediately
loadFirebaseService();

// Event emitter for push events
const pushEvents = new EventEmitter();

// Web Push service configuration
const PUSH_CONFIG = {
  vapid: {
    contact: 'mailto:lovebhumi999@gmail.com',
    publicKey: 'BGNHjlY31Q1NxybqYF5AKKHkzsoT6wIi_tla6MDo9o42XBPm7SdArGXbDu5zjV3O3X1CwfrqMvUkfbc66j309G8',
    privateKey: 'B1DP5JTtagjblyWvQ4cQiaNY6kBD5kWr5YbBazl5RLw',
  },
  settings: {
    ttl: 3600,
    urgency: 'high',
  },
  defaults: {
    icon: '/icons/icon.png',
  },
};

class WebPushService {
  constructor() {
    this.isInitialized = false;
    this.metrics = {
      sent: 0,
      delivered: 0,
      failed: 0,
      expired: 0,
      subscriptions: {
        active: 0,
        total: 0,
        byBrowser: {
          chrome: 0,
          firefox: 0,
          safari: 0,
          edge: 0,
          other: 0
        }
      }
    };
    this.initialize();
  }

  initialize() {
    try {
      const { contact, publicKey, privateKey } = PUSH_CONFIG.vapid;
      if (!publicKey || !privateKey) {
        console.warn('VAPID keys not configured. Web push service disabled.');
        return;
      }
      webPush.setVapidDetails(contact, publicKey, privateKey);
      this.isInitialized = true;
      console.log('Web Push service initialized successfully');
      this.setupMonitoring();
    } catch (error) {
      console.error('Failed to initialize web push service:', error);
      this.isInitialized = false;
    }
  }

  setupMonitoring() {
    setInterval(async () => {
      await this.updateSubscriptionMetrics();
    }, 60 * 60 * 1000);
    setInterval(() => {
      console.log('Web Push metrics:', this.metrics);
      pushEvents.emit('metrics:hourly', { ...this.metrics });
    }, 60 * 60 * 1000);
    setInterval(async () => {
      await this.cleanupExpiredSubscriptions();
    }, 24 * 60 * 60 * 1000);
  }

  async addSubscription(userId, subscription, metadata = {}) {
    console.log("Adding subscription for userId:", userId);
    if (!this.isInitialized) {
      throw new Error('Web push service not initialized');
    }
    try {
      this.validateSubscription(subscription);
     
      let user = await NotificationUser.findOne({ userId });
      if (!user) {
        console.log("Creating new user for web push subscription:", userId);
        user = new NotificationUser({
          userId,
          pushSubscriptions: [],
          preferences: { enabled: true }
        });
      }
      let deviceToken = await DeviceToken.findOne({
        userId,
        token: subscription.endpoint,
        platform: 'web',
        'deletion.isDeleted': false
      });
      if (deviceToken) {
        deviceToken.status = 'active';
        deviceToken.deviceInfo = {
          ...deviceToken.deviceInfo,
          browser: this.detectBrowser(metadata.userAgent),
          os: this.detectOS(metadata.userAgent),
          userAgent: metadata.userAgent
        };
        deviceToken.provider.keys = subscription.keys;
        await deviceToken.save();
        console.log("Updated existing device token:", deviceToken.tokenId);
      } else {
        const tokenData = {
          userId,
          platform: 'web',
          token: subscription.endpoint,
          provider: {
            service: 'web-push',
            endpoint: subscription.endpoint,
            keys: subscription.keys
          },
          deviceInfo: {
            browser: this.detectBrowser(metadata.userAgent),
            os: this.detectOS(metadata.userAgent),
            userAgent: metadata.userAgent
          },
          security: {
            ipAddress: metadata.ipAddress || 'unknown',
            userAgent: metadata.userAgent || 'unknown',
            registrationSource: 'web-push-api'
          },
          status: 'active'
        };
        deviceToken = await DeviceToken.create(tokenData);
        console.log("Created new device token:", deviceToken.tokenId);
      }
      const existingIndex = user.pushSubscriptions.findIndex(
        sub => sub.endpoint === subscription.endpoint
      );
      if (existingIndex !== -1) {
   user.pushSubscriptions[existingIndex] = {
  ...user.pushSubscriptions[existingIndex],
  ...subscription,
  isActive: true,
  lastUsedAt: new Date(),
  userAgent: metadata.userAgent,
  browser: this.detectBrowser(metadata.userAgent),
  os: this.detectOS(metadata.userAgent),
};

        console.log(`Updated existing web push subscription for user ${userId}`);
      } else {
        const activeSubscriptions = user.pushSubscriptions.filter(sub => sub.isActive);
        if (activeSubscriptions.length >= PUSH_CONFIG.settings.maxSubscriptionsPerUser) {
          const oldestIndex = user.pushSubscriptions.reduce((oldest, sub, index) => {
            return sub.lastUsedAt < user.pushSubscriptions[oldest].lastUsedAt ? index : oldest;
          }, 0);
          user.pushSubscriptions[oldestIndex].isActive = false;
          console.log(`Deactivated oldest subscription for user ${userId} (limit reached)`);
        }
       
        const newSubscription = {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
          userAgent: metadata.userAgent,
          browser: this.detectBrowser(metadata.userAgent),
          os: this.detectOS(metadata.userAgent),
          isActive: true,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          subscriptionId: this.generateSubscriptionId(subscription.endpoint)
        };
        user.pushSubscriptions.push(newSubscription);
        console.log(`Added new web push subscription for user ${userId}`);
      }
     
   user.compliance.auditLog.push({
  action: existingIndex !== -1 ? 'subscription_updated' : 'subscription_added',
  timestamp: new Date(),
  details: `Browser: ${this.detectBrowser(metadata.userAgent)}`,
  ipAddress: metadata.ipAddress
});

     
      await user.save();
      console.log("User saved successfully with push subscription");
     
      const testResult = await this.testSubscription(subscription);
      if (!testResult.success) {
        console.warn(`Subscription test failed for user ${userId}: ${testResult.error}`);
      }
     
      pushEvents.emit('subscription:added', {
        userId,
        endpoint: subscription.endpoint,
        browser: this.detectBrowser(metadata.userAgent),
        success: testResult.success
      });
     
      this.metrics.subscriptions.total = user.pushSubscriptions.length;
      this.metrics.subscriptions.active = user.pushSubscriptions.filter(sub => sub.isActive).length;
     
      console.log("subscription added successfully");
     
      return {
        success: true,
        user,
        subscriptionId: user.pushSubscriptions[user.pushSubscriptions.length - 1].subscriptionId,
        tested: testResult.success,
        deviceTokenId: deviceToken.tokenId
      };
    } catch (error) {
      console.error('Failed to add web push subscription:', error);
      pushEvents.emit('subscription:error', {
        userId,
        error: error.message,
        endpoint: subscription?.endpoint
      });
      throw error;
    }
  }

  validateSubscription(subscription) {
    if (!subscription) {
      throw new Error('Subscription object is required');
    }
    if (!subscription.endpoint) {
      throw new Error('Subscription endpoint is required');
    }
    if (!subscription.endpoint.startsWith('https://')) {
      throw new Error('Subscription endpoint must be HTTPS');
    }
    if (!subscription.keys) {
      throw new Error('Subscription keys are required');
    }
    if (!subscription.keys.p256dh || !subscription.keys.auth) {
      throw new Error('Subscription keys must include p256dh and auth');
    }
    const base64urlRegex = /^[A-Za-z0-9_-]+$/;
    if (!base64urlRegex.test(subscription.keys.p256dh)) {
      throw new Error('Invalid p256dh key format');
    }
    if (!base64urlRegex.test(subscription.keys.auth)) {
      throw new Error('Invalid auth key format');
    }
  }

  generateSubscriptionId(endpoint) {
    return crypto.createHash('sha256')
      .update(endpoint + Date.now())
      .digest('hex')
      .substring(0, 16);
  }

  detectBrowser(userAgent) {
    if (!userAgent) return 'unknown';
    const ua = userAgent.toLowerCase();
    if (ua.includes('chrome') && !ua.includes('edge')) return 'chrome';
    if (ua.includes('firefox')) return 'firefox';
    if (ua.includes('safari') && !ua.includes('chrome')) return 'safari';
    if (ua.includes('edge')) return 'edge';
    if (ua.includes('opera')) return 'opera';
    return 'other';
  }

  detectOS(userAgent) {
    if (!userAgent) return 'unknown';
    const ua = userAgent.toLowerCase();
    if (ua.includes('windows')) return 'windows';
    if (ua.includes('mac os')) return 'macos';
    if (ua.includes('linux')) return 'linux';
    if (ua.includes('android')) return 'android';
    if (ua.includes('ios')) return 'ios';
    return 'unknown';
  }

  async testSubscription(subscription, options = {}) {
    try {
      const testPayload = JSON.stringify({
        title: 'Subscription Test',
        body: 'Your push notifications are working!',
        icon: PUSH_CONFIG.defaults.icon,
        badge: PUSH_CONFIG.defaults.badge,
        tag: 'test',
        data: {
          test: true,
          timestamp: Date.now()
        },
        actions: [],
        silent: true
      });
      const pushOptions = {
        TTL: 60,
        urgency: 'low',
        topic: 'test',
        ...options
      };
      const result = await webPush.sendNotification(subscription, testPayload, pushOptions);
      return {
        success: true,
        statusCode: result.statusCode,
        headers: result.headers
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        statusCode: error.statusCode
      };
    }
  }

  async send(userId, payload, options = {}) {
    if (!this.isInitialized) {
      console.warn('Web push service not initialized');
      return { success: false, error: 'Service not available' };
    }
    try {
      const user = await NotificationUser.findOne({ userId });
      if (!user) {
        return { success: false, error: 'User not found' };
      }
     
      if (!user.canReceiveNotification || !user.canReceiveNotification(payload.type || 'general', 'push', payload.priority || 'medium')) {
        return { success: false, error: 'User preferences block push notifications' };
      }
     
      const activeSubscriptions = user.pushSubscriptions.filter(sub => sub.isActive);
      if (!activeSubscriptions.length) {
        return { success: false, error: 'No active push subscriptions found' };
      }
     
      const notificationPayload = this.buildNotificationPayload(payload, options);
      const pushOptions = this.buildPushOptions(payload, options);
     
      const results = await this.sendToSubscriptions(
        activeSubscriptions,
        notificationPayload,
        pushOptions,
        userId
      );
     
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
     
      this.metrics.sent += successCount;
      this.metrics.failed += failCount;
     
      if (successCount > 0 && user.recordNotificationReceived) {
        await user.recordNotificationReceived('push');
      }
     
      await this.handleFailedSubscriptions(user, results);
     
      pushEvents.emit('notification:sent', {
        userId,
        payload: payload.title,
        subscriptions: activeSubscriptions.length,
        success: successCount,
        failed: failCount
      });
     
      return {
        success: successCount > 0,
        totalSubscriptions: activeSubscriptions.length,
        sent: successCount,
        failed: failCount,
        results: results.filter(r => !r.success)
      };
    } catch (error) {
      console.error('Web push send error:', error);
      this.metrics.failed++;
      return {
        success: false,
        error: error.message
      };
    }
  }

  buildNotificationPayload(payload, options = {}) {
    const notification = {
      title: payload.title,
      body: payload.body,
      icon: payload.icon || options.icon || PUSH_CONFIG.defaults.icon,
      badge: payload.badge || options.badge || PUSH_CONFIG.defaults.badge,
      image: payload.image,
      data: {
        notificationId: payload.notificationId,
        type: payload.type || 'general',
        url: payload.url,
        timestamp: Date.now(),
        ...(payload.data || {})
      },
      actions: payload.actions || [],
      tag: payload.tag || options.tag || PUSH_CONFIG.defaults.tag,
      renotify: payload.renotify || options.renotify || PUSH_CONFIG.defaults.renotify,
      requireInteraction: payload.requireInteraction || options.requireInteraction ||
                          (payload.priority === 'high') || PUSH_CONFIG.defaults.requireInteraction,
      silent: payload.silent || options.silent || PUSH_CONFIG.defaults.silent,
      vibrate: payload.vibrate || options.vibrate || PUSH_CONFIG.defaults.vibrate
    };
    if (payload.dir) notification.dir = payload.dir;
    if (payload.lang) notification.lang = payload.lang;
    if (payload.timestamp) notification.timestamp = payload.timestamp;
    return JSON.stringify(notification);
  }

  buildPushOptions(payload, options = {}) {
    const ttl = payload.priority === 'critical' ? PUSH_CONFIG.settings.urgentTTL :
                payload.ttl || options.ttl || PUSH_CONFIG.settings.ttl;
    return {
      TTL: ttl,
      urgency: this.mapPriorityToUrgency(payload.priority || 'medium'),
      topic: payload.topic || payload.type || 'default',
      headers: {
        'Content-Encoding': 'aesgcm',
        ...(options.headers || {})
      },
      timeout: options.timeout || PUSH_CONFIG.settings.timeout
    };
  }

  mapPriorityToUrgency(priority) {
    const mapping = {
      critical: 'high',
      high: 'high',
      medium: 'normal',
      low: 'low'
    };
    return mapping[priority] || 'normal';
  }

  async sendToSubscriptions(subscriptions, payload, pushOptions, userId) {
    const results = [];
    const promises = [];
    for (let i = 0; i < subscriptions.length; i += PUSH_CONFIG.settings.batchSize) {
      const batch = subscriptions.slice(i, i + PUSH_CONFIG.settings.batchSize);
      const batchPromises = batch.map(async (subscription) => {
        let attempt = 0;
        let lastError;
        while (attempt < PUSH_CONFIG.settings.retryAttempts) {
          try {
            const result = await webPush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: subscription.keys
              },
              payload,
              pushOptions
            );
            subscription.lastUsedAt = new Date();
            return {
              success: true,
              subscriptionId: subscription.subscriptionId,
              endpoint: subscription.endpoint,
              statusCode: result.statusCode,
              headers: result.headers,
              attempt: attempt + 1
            };
          } catch (error) {
            lastError = error;
            attempt++;
            if (this.isPermanentError(error)) {
              break;
            }
            if (attempt < PUSH_CONFIG.settings.retryAttempts) {
              await new Promise(resolve =>
                setTimeout(resolve, PUSH_CONFIG.settings.retryDelay * attempt)
              );
            }
          }
        }
        return {
          success: false,
          subscriptionId: subscription.subscriptionId,
          endpoint: subscription.endpoint,
          error: lastError.message,
          statusCode: lastError.statusCode,
          attempts: attempt,
          isPermanent: this.isPermanentError(lastError)
        };
      });
      promises.push(...batchPromises);
    }
    const batchResults = await Promise.allSettled(promises);
    batchResults.forEach(result => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push({
          success: false,
          error: result.reason.message,
          endpoint: 'unknown'
        });
      }
    });
    return results;
  }

  isPermanentError(error) {
    const permanentStatusCodes = [400, 403, 404, 410, 413];
    return permanentStatusCodes.includes(error.statusCode);
  }

  async handleFailedSubscriptions(user, results) {
    const expiredSubscriptions = results.filter(r =>
      !r.success && (r.statusCode === 410 || r.statusCode === 404)
    );
    if (expiredSubscriptions.length > 0) {
      expiredSubscriptions.forEach(expired => {
        const subscription = user.pushSubscriptions.find(sub =>
          sub.subscriptionId === expired.subscriptionId
        );
        if (subscription) {
          subscription.isActive = false;
        }
      });
      await user.save();
      this.metrics.expired += expiredSubscriptions.length;
      console.log(`Marked ${expiredSubscriptions.length} expired subscriptions as inactive for user ${user.userId}`);
    }
  }

  async removeSubscription(userId, endpoint) {
    try {
      const user = await NotificationUser.findOne({ userId });
      if (!user) {
        return { success: false, error: 'User not found' };
      }
      const subscriptionIndex = user.pushSubscriptions.findIndex(
        sub => sub.endpoint === endpoint
      );
      if (subscriptionIndex === -1) {
        return { success: false, error: 'Subscription not found' };
      }
      user.pushSubscriptions.splice(subscriptionIndex, 1);
      user.compliance.auditLog.push({
        action: 'subscription_removed',
        timestamp: new Date(),
        details: `Endpoint: ${endpoint}`
      });
      await user.save();
     
      await DeviceToken.updateOne(
        { userId, token: endpoint, platform: 'web' },
        { $set: { 'deletion.isDeleted': true, 'deletion.deletedAt': new Date() } }
      );
     
      pushEvents.emit('subscription:removed', {
        userId,
        endpoint
      });
      return { success: true, message: 'Subscription removed successfully' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getUserSubscriptions(userId, activeOnly = true) {
    try {
      const user = await NotificationUser.findOne({ userId });
      if (!user) {
        return { success: false, error: 'User not found' };
      }
      let subscriptions = user.pushSubscriptions || [];
      if (activeOnly) {
        subscriptions = subscriptions.filter(sub => sub.isActive);
      }
      const sanitizedSubscriptions = subscriptions.map(sub => ({
        subscriptionId: sub.subscriptionId,
        browser: sub.browser,
        os: sub.os,
        isActive: sub.isActive,
        createdAt: sub.createdAt,
        lastUsedAt: sub.lastUsedAt
      }));
      return {
        success: true,
        subscriptions: sanitizedSubscriptions,
        count: sanitizedSubscriptions.length
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async updateSubscriptionMetrics() {
    try {
      const pipeline = [
        { $unwind: '$pushSubscriptions' },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: {
              $sum: {
                $cond: ['$pushSubscriptions.isActive', 1, 0]
              }
            },
            byBrowser: {
              $push: '$pushSubscriptions.browser'
            }
          }
        }
      ];
      const result = await NotificationUser.aggregate(pipeline);
      if (result.length > 0) {
        const data = result[0];
        this.metrics.subscriptions.total = data.total;
        this.metrics.subscriptions.active = data.active;
        const browserCounts = data.byBrowser.reduce((acc, browser) => {
          acc[browser] = (acc[browser] || 0) + 1;
          return acc;
        }, {});
        Object.keys(this.metrics.subscriptions.byBrowser).forEach(browser => {
          this.metrics.subscriptions.byBrowser[browser] = browserCounts[browser] || 0;
        });
      }
    } catch (error) {
      console.error('Failed to update subscription metrics:', error);
    }
  }

  async cleanupExpiredSubscriptions() {
    try {
      console.log('Running push subscription cleanup...');
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await NotificationUser.updateMany(
        {},
        {
          $pull: {
            pushSubscriptions: {
              isActive: false,
              lastUsedAt: { $lt: thirtyDaysAgo }
            }
          }
        }
      );
      console.log(`Removed ${result.modifiedCount} expired push subscriptions`);
      pushEvents.emit('cleanup:completed', {
        removedSubscriptions: result.modifiedCount,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Push subscription cleanup error:', error);
      pushEvents.emit('cleanup:error', {
        error: error.message,
        timestamp: new Date()
      });
    }
  }

  async sendBulk(notificationList, options = {}) {
    const results = [];
    const errors = [];
    for (const notification of notificationList) {
      try {
        const result = await this.send(
          notification.userId,
          notification.payload,
          notification.options
        );
        if (result.success) {
          results.push({
            userId: notification.userId,
            result
          });
        } else {
          errors.push({
            userId: notification.userId,
            error: result.error
          });
        }
      } catch (error) {
        errors.push({
          userId: notification.userId,
          error: error.message
        });
      }
    }
    return {
      success: true,
      total: notificationList.length,
      sent: results.length,
      failed: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  async testPushService(testSubscription = null) {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }
    try {
      const subscription = testSubscription || {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        keys: {
          p256dh: 'test-p256dh-key',
          auth: 'test-auth-key'
        }
      };
      const testPayload = {
        title: 'Push Service Test',
        body: 'This is a test push notification from Throne8',
        type: 'system',
        priority: 'low',
        data: {
          test: true,
          timestamp: new Date().toISOString()
        }
      };
      const result = await this.testSubscription(subscription, { test: true });
      return {
        success: result.success,
        statusCode: result.statusCode,
        timestamp: new Date()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date()
      };
    }
  }

  getHealthStatus() {
    const totalSent = this.metrics.sent + this.metrics.failed;
    const successRate = totalSent > 0 ? (this.metrics.sent / totalSent) * 100 : 100;
    return {
      status: this.isInitialized ? 'healthy' : 'unhealthy',
      metrics: {
        ...this.metrics,
        successRate: Math.round(successRate * 100) / 100
      },
      vapid: {
        configured: !!(PUSH_CONFIG.vapid.publicKey && PUSH_CONFIG.vapid.privateKey),
        contact: PUSH_CONFIG.vapid.contact
      },
      settings: PUSH_CONFIG.settings,
      isInitialized: this.isInitialized,
      firebase: firebaseAdminService ? firebaseAdminService.getHealth() : { available: false }
    };
  }

  resetMetrics() {
    this.metrics = {
      sent: 0,
      delivered: 0,
      failed: 0,
      expired: 0,
      subscriptions: {
        active: 0,
        total: 0,
        byBrowser: {
          chrome: 0,
          firefox: 0,
          safari: 0,
          edge: 0,
          other: 0
        }
      }
    };
  }

  async sendTest(userId) {
    const testNotification = {
      title: 'Test Notification from Throne8',
      body: 'This is a test notification to verify your push setup is working!',
      data: {
        test: 'true',
        timestamp: new Date().toISOString(),
        type: 'system'
      }
    };
    return await this.send(userId, testNotification, { test: true });
  }

  async sendWithActions(userId, payload, actions, options = {}) {
    const enhancedPayload = {
      ...payload,
      actions: actions.map(action => ({
        action: action.id,
        title: action.title,
        icon: action.icon
      })),
      requireInteraction: true
    };
    return this.send(userId, enhancedPayload, options);
  }

  async sendSilent(userId, data, options = {}) {
    const silentPayload = {
      title: '',
      body: '',
      silent: true,
      data: {
        silent: true,
        action: 'background-sync',
        ...data
      }
    };
    return this.send(userId, silentPayload, {
      ...options,
      urgency: 'low',
      TTL: 300
    });
  }

  async sendToBrowser(userId, browserType, payload, options = {}) {
    const user = await NotificationUser.findOne({ userId });
    if (!user) {
      return { success: false, error: 'User not found' };
    }
    const browserSubscriptions = user.pushSubscriptions.filter(
      sub => sub.isActive && sub.browser === browserType
    );
    if (!browserSubscriptions.length) {
      return {
        success: false,
        error: `No active subscriptions found for browser: ${browserType}`
      };
    }
    const notificationPayload = this.buildNotificationPayload(payload, options);
    const pushOptions = this.buildPushOptions(payload, options);
    const results = await this.sendToSubscriptions(
      browserSubscriptions,
      notificationPayload,
      pushOptions,
      userId
    );
    const successCount = results.filter(r => r.success).length;
    return {
      success: successCount > 0,
      browser: browserType,
      subscriptions: browserSubscriptions.length,
      sent: successCount,
      failed: results.length - successCount
    };
  }

  async sendScheduled(userId, payload, scheduleTime, options = {}) {
    const delay = new Date(scheduleTime).getTime() - Date.now();
    if (delay <= 0) {
      return { success: false, error: 'Schedule time must be in the future' };
    }
    const scheduledPayload = {
      ...payload,
      timestamp: new Date(scheduleTime).getTime(),
      tag: `scheduled-${Date.now()}`,
      data: {
        ...payload.data,
        scheduled: true,
        scheduleTime
      }
    };
    return this.send(userId, scheduledPayload, options);
  }

  async sendRichNotification(userId, payload, options = {}) {
    const richPayload = {
      ...payload,
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 200],
      actions: payload.actions || [
        { action: 'view', title: 'View', icon: '/icons/view.png' },
        { action: 'dismiss', title: 'Dismiss', icon: '/icons/dismiss.png' }
      ]
    };
    return this.send(userId, richPayload, {
      ...options,
      urgency: 'high'
    });
  }

  async getHealth() {
    const webPushHealth = this.getHealthStatus();
   
    const firebaseHealth = firebaseAdminService ? firebaseAdminService.getHealth() : { initialized: false };
    let platformCounts = {};
    try {
      const tokenStats = await DeviceToken.aggregate([
        {
          $match: {
            status: 'active',
            'deletion.isDeleted': false
          }
        },
        {
          $group: {
            _id: '$platform',
            count: { $sum: 1 }
          }
        }
      ]);
      platformCounts = tokenStats.reduce((acc, stat) => {
        acc[stat._id] = stat.count;
        return acc;
      }, {});
    } catch (error) {
      console.warn('Failed to get platform counts:', error.message);
    }
    return {
      status: webPushHealth.status === 'healthy' && (firebaseHealth.initialized || !firebaseAdminService) ? 'healthy' : 'degraded',
      services: {
        webPush: {
          status: webPushHealth.status,
          initialized: webPushHealth.isInitialized,
          metrics: webPushHealth.metrics
        },
        firebase: {
          status: firebaseHealth.initialized ? 'healthy' : 'unavailable',
          initialized: firebaseHealth.initialized,
          projectId: firebaseHealth.projectId || 'not-configured'
        }
      },
      deviceTokens: {
        total: Object.values(platformCounts).reduce((a, b) => a + b, 0),
        byPlatform: platformCounts
      },
      timestamp: new Date()
    };
  }

  async subscribeUserToTopic(userId, topic) {
    if (!firebaseAdminService) {
      return {
        success: false,
        error: 'Firebase service not available',
        userId,
        topic
      };
    }
    try {
      const fcmTokens = await DeviceToken.find({
        userId,
        platform: { $in: ['android', 'ios'] },
        status: 'active',
        'deletion.isDeleted': false
      }).select('token');
      if (!fcmTokens.length) {
        return {
          success: false,
          error: 'No FCM tokens found for user',
          userId,
          topic
        };
      }
      const tokens = fcmTokens.map(t => t.token);
      const result = await firebaseAdminService.subscribeToTopic(tokens, topic);
      return {
        success: result.success,
        userId,
        topic,
        tokensProcessed: tokens.length,
        ...result
      };
    } catch (error) {
      console.error('Topic subscription error:', error);
      return {
        success: false,
        error: error.message,
        userId,
        topic
      };
    }
  }

  async sendToTopic(topic, notification, data = {}, options = {}) {
    if (!firebaseAdminService) {
      throw new Error('Firebase service not available');
    }
    try {
      return await firebaseAdminService.sendToTopic(topic, notification, data, options);
    } catch (error) {
      console.error('Topic send error:', error);
      return {
        success: false,
        error: error.message,
        platform: 'fcm'
      };
    }
  }
}

class EnhancedPushService extends WebPushService {
  constructor() {
    super();
    this.firebase = null;
    this.firebaseReady = false;
    this.initFirebase();
  }

  async initFirebase() {
    try {
      this.firebase = await loadFirebaseService();
      this.firebaseReady = !!this.firebase;
     
      if (this.firebaseReady) {
        console.log('Firebase ready in EnhancedPushService');
      } else {
        console.log('Firebase not available in EnhancedPushService');
      }
    } catch (error) {
      console.error('Firebase initialization failed:', error.message);
      this.firebaseReady = false;
    }
  }

  async ensureFirebaseReady() {
    if (!this.firebaseReady && !this.firebase) {
      console.log('Waiting for Firebase to be ready...');
      this.firebase = await loadFirebaseService();
      this.firebaseReady = !!this.firebase;
    }
    return this.firebaseReady;
  }

  async send(userId, notification, options = {}) {
    try {
      console.log(`Sending push notification to user ${userId}`);
     
      const deviceTokens = await DeviceToken.find({
        userId,
        status: 'active',
        'deletion.isDeleted': false
      });
      if (!deviceTokens.length) {
        console.log(`No device tokens found for user: ${userId}`);
        return {
          success: false,
          error: 'No active device tokens found',
        };
      }
      console.log(`Found ${deviceTokens.length} device tokens for user ${userId}`);
      // Ensure Firebase is ready for mobile notifications
      await this.ensureFirebaseReady();
      const results = [];
      for (const deviceToken of deviceTokens) {
        const { platform, token } = deviceToken;
       
        console.log(`Sending to ${platform} token: ${token.substring(0, 20)}...`);
        if (platform === 'web') {
          try {
            const webSubscription = {
              endpoint: token,
              keys: deviceToken.provider.keys
            };
           
            // Note: Since super.send is for web only, we call sendToSubscriptions directly for consistency
            const user = await NotificationUser.findOne({ userId });
            const activeSubs = user.pushSubscriptions.filter(sub => sub.endpoint === token && sub.isActive);
            if (activeSubs.length > 0) {
              const notificationPayload = this.buildNotificationPayload(notification, options);
              const pushOptions = this.buildPushOptions(notification, options);
              const webResults = await this.sendToSubscriptions(activeSubs, notificationPayload, pushOptions, userId);
              webResults.forEach(r => {
                results.push({
                  platform: 'web',
                  tokenId: deviceToken.tokenId,
                  ...r
                });
              });
            } else {
              results.push({
                platform: 'web',
                tokenId: deviceToken.tokenId,
                success: false,
                error: 'No active web subscription found'
              });
            }
          } catch (error) {
            console.error(`Error sending web push to token ${deviceToken.tokenId}:, error.message`);
            results.push({
              platform: 'web',
              tokenId: deviceToken.tokenId,
              success: false,
              error: error.message,
              statusCode: error.statusCode || 500
            });
            this.metrics.failed++;
            if (this.isPermanentError(error)) {
              await DeviceToken.updateOne(
                { _id: deviceToken._id },
                { $set: { status: 'inactive', 'deletion.isDeleted': true, 'deletion.deletedAt': new Date() } }
              );
              console.log(`Deactivated invalid web push token: ${deviceToken.tokenId}`);
              this.metrics.expired++;
            }
          }
        } else if ((platform === 'android' || platform === 'ios') && this.firebase) {
          try {
            const result = await this.firebase.sendToDevice(token, notification, notification.data || {});
            results.push({
              platform,
              tokenId: deviceToken.tokenId,
              ...result
            });
            if (result.shouldRemoveToken) {
              console.log(`Deactivating invalid token: ${deviceToken.tokenId}`);
              await deviceToken.deactivate(result.error);
            }
          } catch (error) {
            results.push({
              platform,
              tokenId: deviceToken.tokenId,
              success: false,
              error: error.message
            });
          }
        } else if ((platform === 'android' || platform === 'ios') && !this.firebase) {
          results.push({
            platform,
            tokenId: deviceToken.tokenId,
            success: false,
            error: 'Firebase service not available'
          });
        }
      }
      const successCount = results.filter(r => r.success).length;
      const totalAttempts = results.length;
      console.log(`Push notification results: ${successCount}/${totalAttempts} successful`);
      return {
        success: successCount > 0,
        totalAttempts,
        successCount,
        failedCount: totalAttempts - successCount,
        results
      };
    } catch (error) {
      console.error('Enhanced push service error:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async registerFCMToken(userId, token, platform, deviceInfo = {}) {
    if (!this.firebase) {
      throw new Error('Firebase service not available');
    }
    try {
      console.log(`Registering FCM token for ${platform}: ${token.substring(0, 20)}...`);
      const testResult = await this.firebase.sendToDevice(token, {
        title: 'Token Test',
        body: 'Validating your device token'
      }, { test: 'true' });
      if (!testResult.success && testResult.shouldRemoveToken) {
        throw new Error('Invalid FCM token provided');
      }
      let deviceToken = await DeviceToken.findOne({
        userId,
        token,
        'deletion.isDeleted': false
      });
      if (deviceToken) {
        deviceToken.status = 'active';
        deviceToken.deviceInfo = { ...deviceToken.deviceInfo, ...deviceInfo };
        deviceToken.lastActivityAt = new Date();
        await deviceToken.save();
       
        console.log(`Updated existing FCM token: ${deviceToken.tokenId}`);
      } else {
        const tokenData = {
          userId,
          platform,
          token,
          provider: {
            service: 'fcm',
            projectId: process.env.FIREBASE_PROJECT_ID
          },
          deviceInfo,
          status: 'active'
        };
        deviceToken = await DeviceToken.create(tokenData);
        console.log(`Created new FCM token: ${deviceToken.tokenId}`);
      }
      return {
        success: true,
        tokenId: deviceToken.tokenId,
        platform,
        message: 'FCM token registered successfully'
      };
    } catch (error) {
      console.error('FCM token registration error:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async getHealth() {
    const webPushHealth = super.getHealthStatus();
   
    await this.ensureFirebaseReady();
    const firebaseHealth = this.firebase ? this.firebase.getHealth() : { initialized: false };
    let platformCounts = {};
    try {
      const tokenStats = await DeviceToken.aggregate([
        {
          $match: {
            status: 'active',
            'deletion.isDeleted': false
          }
        },
        {
          $group: {
            _id: '$platform',
            count: { $sum: 1 }
          }
        }
      ]);
      platformCounts = tokenStats.reduce((acc, stat) => {
        acc[stat._id] = stat.count;
        return acc;
      }, {});
    } catch (error) {
      console.warn('Failed to get platform counts:', error.message);
    }
    return {
      status: webPushHealth.status === 'healthy' && (firebaseHealth.initialized || !this.firebase) ? 'healthy' : 'degraded',
      services: {
        webPush: {
          status: webPushHealth.status,
          initialized: webPushHealth.isInitialized,
          metrics: webPushHealth.metrics
        },
        firebase: {
          status: firebaseHealth.initialized ? 'healthy' : 'unavailable',
          initialized: firebaseHealth.initialized,
          projectId: firebaseHealth.projectId || 'not-configured'
        }
      },
      deviceTokens: {
        total: Object.values(platformCounts).reduce((a, b) => a + b, 0),
        byPlatform: platformCounts
      },
      timestamp: new Date()
    };
  }
}

// Create singleton instances
const webPushService = new WebPushService();
const enhancedPushService = new EnhancedPushService();

// Define exported functions
const addSubscription = (userId, subscription, metadata) =>
  enhancedPushService.addSubscription(userId, subscription, metadata);
const send = (userId, payload, options) =>
  enhancedPushService.send(userId, payload, options);
const sendBulk = (notificationList, options) =>
  enhancedPushService.sendBulk(notificationList, options);
const registerFCMToken = (userId, token, platform, deviceInfo) =>
  enhancedPushService.registerFCMToken(userId, token, platform, deviceInfo);
const sendTest = (userId) =>
  enhancedPushService.sendTest(userId);
const sendWithActions = (userId, payload, actions, options) =>
  enhancedPushService.sendWithActions(userId, payload, actions, options);
const sendSilent = (userId, data, options) =>
  enhancedPushService.sendSilent(userId, data, options);
const sendToBrowser = (userId, browserType, payload, options) =>
  enhancedPushService.sendToBrowser(userId, browserType, payload, options);
const sendScheduled = (userId, payload, scheduleTime, options) =>
  enhancedPushService.sendScheduled(userId, payload, scheduleTime, options);
const sendRichNotification = (userId, payload, options) =>
  enhancedPushService.sendRichNotification(userId, payload, options);
const removeSubscription = (userId, endpoint) =>
  enhancedPushService.removeSubscription(userId, endpoint);
const getUserSubscriptions = (userId, activeOnly) =>
  enhancedPushService.getUserSubscriptions(userId, activeOnly);
const testPushService = (testSubscription) =>
  enhancedPushService.testPushService(testSubscription);
const getHealthStatus = () =>
  enhancedPushService.getHealth();
const subscribeUserToTopic = (userId, topic) =>
  enhancedPushService.subscribeUserToTopic(userId, topic);
const sendToTopic = (topic, notification, data, options) =>
  enhancedPushService.sendToTopic(topic, notification, data, options);

const generateClientScript = () => {
  return `
// Throne8 Web Push Client SDK
class Throne8WebPush {
  constructor(config) {
    this.config = {
      vapidPublicKey: '${PUSH_CONFIG.vapid.publicKey || ''}',
      apiEndpoint: '/api/v1/notifications/push/subscribe',
      ...config
    };
    this.registration = null;
    this.subscription = null;
  }
  async initialize() {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service Worker not supported');
    }
    if (!('PushManager' in window)) {
      throw new Error('Push messaging not supported');
    }
    this.registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    console.log('Throne8 Web Push initialized');
  }
  async requestPermission() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('Notification permission denied');
    }
    return permission;
  }
  async subscribe(userId) {
    if (!this.registration) {
      await this.initialize();
    }
    await this.requestPermission();
    const applicationServerKey = this.urlBase64ToUint8Array(this.config.vapidPublicKey);
    this.subscription = await this.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
    const response = await fetch(this.config.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        userId,
        subscription: this.subscription.toJSON(),
        metadata: {
          userAgent: navigator.userAgent,
          url: window.location.href,
          timestamp: new Date().toISOString()
        }
      })
    });
    if (!response.ok) {
      throw new Error('Failed to save subscription');
    }
    console.log('Successfully subscribed to push notifications');
    return this.subscription;
  }
  async unsubscribe(userId) {
    if (!this.subscription) {
      return false;
    }
    const success = await this.subscription.unsubscribe();
    if (success) {
      console.log('Successfully unsubscribed from push notifications');
      await fetch('/api/v1/notifications/push/unsubscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId,
          endpoint: this.subscription.endpoint
        })
      });
    }
    this.subscription = null;
    return success;
  }
  async isSubscribed() {
    if (!this.registration) {
      return false;
    }
    this.subscription = await this.registration.pushManager.getSubscription();
    return !!this.subscription;
  }
  urlBase64ToUint8Array(base64String) {
    if (!base64String) {
      throw new Error('VAPID public key is required');
    }
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
}
window.Throne8WebPush = Throne8WebPush;
`;
};

const serveClientScript = (req, res) => {
  const script = generateClientScript();
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(script);
};

const serveServiceWorker = (req, res) => {
  const serviceWorker = `
// Throne8 Push Service Worker
self.addEventListener('push', function(event) {
  if (!event.data) return;
  const data = event.data.json();
  if (data.silent) return;
  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192x192.png',
    badge: data.badge || '/icons/badge-72x72.png',
    image: data.image,
    vibrate: data.vibrate || [200, 100, 200],
    data: data.data || {},
    actions: data.actions || [],
    requireInteraction: data.requireInteraction || false,
    tag: data.tag || 'default',
    timestamp: data.timestamp || Date.now()
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Throne8', options)
  );
});
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
self.addEventListener('notificationclose', function(event) {
  console.log('Notification closed:', event);
  const notificationData = event.notification.data || {};
  if (notificationData.trackDismissal) {
    fetch('/api/notifications/track/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notificationId: notificationData.notificationId,
        timestamp: Date.now()
      })
    }).catch(err => console.error('Failed to track dismissal:', err));
  }
});
self.addEventListener('sync', function(event) {
  if (event.tag === 'throne8-sync') {
    event.waitUntil(
      fetch('/api/sync')
        .then(response => response.json())
        .then(data => {
          if (data.notifications) {
            data.notifications.forEach(notification => {
              self.registration.showNotification(
                notification.title,
                notification.options
              );
            });
          }
        })
        .catch(err => console.error('Background sync failed:', err))
    );
  }
});
`;
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(serviceWorker);
};

// Export the enhanced service as default
export default enhancedPushService;

// Consolidated named exports
export {
  webPushService,
  pushEvents,
  addSubscription,
  send,
  sendBulk,
  registerFCMToken,
  sendTest,
  sendWithActions,
  sendSilent,
  sendToBrowser,
  sendScheduled,
  sendRichNotification,
  removeSubscription,
  getUserSubscriptions,
  testPushService,
  getHealthStatus,
  subscribeUserToTopic,
  sendToTopic,
  generateClientScript,
  serveClientScript,
  serveServiceWorker
};