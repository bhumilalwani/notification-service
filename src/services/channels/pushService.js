import webPush from 'web-push';
import { EventEmitter } from 'events';
import NotificationUser from '../../models/User.js';
import crypto from 'crypto';

// Event emitter for push events
export const pushEvents = new EventEmitter();

// Web Push service configuration
const PUSH_CONFIG = {
  vapid: {
    contact: process.env.VAPID_CONTACT || process.env.VAPID_SUBJECT || 'mailto:admin@throne8.com',
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  },
  // Push service settings
  settings: {
    ttl: 24 * 60 * 60, // 24 hours in seconds
    maxSubscriptionsPerUser: 10,
    retryAttempts: 3,
    retryDelay: 1000, // 1 second
    batchSize: 100, // Max subscriptions to process at once
    urgentTTL: 60, // 1 minute for urgent messages
    timeout: 30000 // 30 seconds request timeout
  },
  // Notification defaults
  defaults: {
    icon: '/icons/icon-192x192.png',
    badge: '/icons/badge-72x72.png',
    vibrate: [200, 100, 200],
    requireInteraction: false,
    silent: false,
    renotify: false,
    tag: 'default'
  }
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

  // Initialize web push service
  initialize() {
    try {
      const { contact, publicKey, privateKey } = PUSH_CONFIG.vapid;
      if (!publicKey || !privateKey) {
        console.warn('VAPID keys not configured. Web push service disabled.');
        return;
      }
      // Set VAPID details
      webPush.setVapidDetails(contact, publicKey, privateKey);
      this.isInitialized = true;
      console.log('Web Push service initialized successfully');
      // Setup monitoring
      this.setupMonitoring();
    } catch (error) {
      console.error('Failed to initialize web push service:', error);
      this.isInitialized = false;
    }
  }

  // Setup monitoring and cleanup
  setupMonitoring() {
    // Update subscription metrics every hour
    setInterval(async () => {
      await this.updateSubscriptionMetrics();
    }, 60 * 60 * 1000); // 1 hour
    // Report metrics every hour
    setInterval(() => {
      console.log('Web Push metrics:', this.metrics);
      pushEvents.emit('metrics:hourly', { ...this.metrics });
    }, 60 * 60 * 1000); // 1 hour
    // Cleanup expired subscriptions daily
    setInterval(async () => {
      await this.cleanupExpiredSubscriptions();
    }, 24 * 60 * 60 * 1000); // 24 hours
  }

  // Add or update subscription with enhanced validation
  async addSubscription(userId, subscription, metadata = {}) {
    if (!this.isInitialized) {
      throw new Error('Web push service not initialized');
    }
    try {
      // Validate subscription object
      this.validateSubscription(subscription);
      // Get or create user
      let user = await NotificationUser.findOne({ userId });
      if (!user) {
        user = new NotificationUser({
          userId,
          pushSubscriptions: [],
          preferences: { enabled: true }
        });
      }
      // Check if subscription already exists
      const existingIndex = user.pushSubscriptions.findIndex(
        sub => sub.endpoint === subscription.endpoint
      );
      if (existingIndex !== -1) {
        // Update existing subscription
        user.pushSubscriptions[existingIndex] = {
          ...user.pushSubscriptions[existingIndex],
          ...subscription,
          isActive: true,
          lastUsedAt: new Date(),
          userAgent: metadata.userAgent,
          browser: this.detectBrowser(metadata.userAgent),
          os: this.detectOS(metadata.userAgent)
        };
        console.log(`Updated existing web push subscription for user ${userId}`);
      } else {
        // Add new subscription
        // Check subscription limit
        const activeSubscriptions = user.pushSubscriptions.filter(sub => sub.isActive);
        if (activeSubscriptions.length >= PUSH_CONFIG.settings.maxSubscriptionsPerUser) {
          // Remove oldest subscription
          const oldestIndex = user.pushSubscriptions.reduce((oldest, sub, index) => {
            return sub.lastUsedAt < user.pushSubscriptions[oldest].lastUsedAt ? index : oldest;
          }, 0);
          user.pushSubscriptions[oldestIndex].isActive = false;
          console.log(`Deactivated oldest subscription for user ${userId} (limit reached)`);
        }
        // Add new subscription
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
      // Update user audit log
      user.compliance.auditLog.push({
        action: existingIndex !== -1 ? 'subscription_updated' : 'subscription_added',
        timestamp: new Date(),
        details: `Browser: ${this.detectBrowser(metadata.userAgent)}`,
        ipAddress: metadata.ipAddress
      });
      await user.save();
      // Test the subscription
      const testResult = await this.testSubscription(subscription);
      if (!testResult.success) {
        console.warn(`Subscription test failed for user ${userId}: ${testResult.error}`);
      }
      // Emit subscription event
      pushEvents.emit('subscription:added', {
        userId,
        endpoint: subscription.endpoint,
        browser: this.detectBrowser(metadata.userAgent),
        success: testResult.success
      });
      // Update metrics
      this.metrics.subscriptions.total = user.pushSubscriptions.length;
      this.metrics.subscriptions.active = user.pushSubscriptions.filter(sub => sub.isActive).length;
      return {
        success: true,
        user,
        subscriptionId: user.pushSubscriptions[user.pushSubscriptions.length - 1].subscriptionId,
        tested: testResult.success
      };
    } catch (error) {
      console.error('Failed to add subscription:', error);
      pushEvents.emit('subscription:error', {
        userId,
        error: error.message,
        endpoint: subscription?.endpoint
      });
      throw error;
    }
  }

  // Validate subscription object
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
    // Validate key formats (base64url)
    const base64urlRegex = /^[A-Za-z0-9_-]+$/;
    if (!base64urlRegex.test(subscription.keys.p256dh)) {
      throw new Error('Invalid p256dh key format');
    }
    if (!base64urlRegex.test(subscription.keys.auth)) {
      throw new Error('Invalid auth key format');
    }
  }

  // Generate unique subscription ID
  generateSubscriptionId(endpoint) {
    return crypto.createHash('sha256')
      .update(endpoint + Date.now())
      .digest('hex')
      .substring(0, 16);
  }

  // Detect browser from user agent
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

  // Detect OS from user agent
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

  // Test subscription by sending a test notification
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
        silent: true // Make test notification silent
      });
      const pushOptions = {
        TTL: 60, // 1 minute TTL for test
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

  // Main send function with enhanced features
  async send(userId, payload, options = {}) {
    if (!this.isInitialized) {
      console.warn('Web push service not initialized');
      return { success: false, error: 'Service not available' };
    }
    try {
      // Get user data
      const user = await NotificationUser.findOne({ userId });
      if (!user) {
        return { success: false, error: 'User not found' };
      }
      // Check if user can receive push notifications
      if (!user.canReceiveNotification(payload.type || 'general', 'push', payload.priority || 'medium')) {
        return { success: false, error: 'User preferences block push notifications' };
      }
      // Get active subscriptions
      const activeSubscriptions = user.pushSubscriptions.filter(sub => sub.isActive);
      if (!activeSubscriptions.length) {
        return { success: false, error: 'No active push subscriptions found' };
      }
      // Prepare notification payload
      const notificationPayload = this.buildNotificationPayload(payload, options);
      // Prepare push options
      const pushOptions = this.buildPushOptions(payload, options);
      // Send to all active subscriptions
      const results = await this.sendToSubscriptions(
        activeSubscriptions,
        notificationPayload,
        pushOptions,
        userId
      );
      // Process results
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      // Update metrics
      this.metrics.sent += successCount;
      this.metrics.failed += failCount;
      // Update user metrics
      if (successCount > 0) {
        await user.recordNotificationReceived('push');
      }
      // Handle failed subscriptions
      await this.handleFailedSubscriptions(user, results);
      // Emit send event
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
        results: results.filter(r => !r.success) // Only return failed results for debugging
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

  // Build notification payload
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
    // Add custom fields based on browser capabilities
    if (payload.dir) notification.dir = payload.dir; // Text direction
    if (payload.lang) notification.lang = payload.lang; // Language
    if (payload.timestamp) notification.timestamp = payload.timestamp;
    return JSON.stringify(notification);
  }

  // Build push options
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

  // Map notification priority to web push urgency
  mapPriorityToUrgency(priority) {
    const mapping = {
      critical: 'high',
      high: 'high',
      medium: 'normal',
      low: 'low'
    };
    return mapping[priority] || 'normal';
  }

  // Send to multiple subscriptions with error handling
  async sendToSubscriptions(subscriptions, payload, pushOptions, userId) {
    const results = [];
    const promises = [];
    // Process subscriptions in batches
    for (let i = 0; i < subscriptions.length; i += PUSH_CONFIG.settings.batchSize) {
      const batch = subscriptions.slice(i, i + PUSH_CONFIG.settings.batchSize);
      const batchPromises = batch.map(async (subscription) => {
        let attempt = 0;
        let lastError;
        // Retry logic
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
            // Update subscription last used time
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
            // Don't retry for certain errors
            if (this.isPermanentError(error)) {
              break;
            }
            // Wait before retry
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
    // Wait for all promises to complete
    const batchResults = await Promise.allSettled(promises);
    // Process results
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

  // Check if error is permanent (don't retry)
  isPermanentError(error) {
    const permanentStatusCodes = [400, 403, 404, 410, 413];
    return permanentStatusCodes.includes(error.statusCode);
  }

  // Handle failed subscriptions
  async handleFailedSubscriptions(user, results) {
    const expiredSubscriptions = results.filter(r =>
      !r.success && (r.statusCode === 410 || r.statusCode === 404)
    );
    if (expiredSubscriptions.length > 0) {
      // Mark expired subscriptions as inactive
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

  // Send bulk notifications
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

  // Remove subscription
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
      // Remove subscription
      user.pushSubscriptions.splice(subscriptionIndex, 1);
      // Add audit log
      user.compliance.auditLog.push({
        action: 'subscription_removed',
        timestamp: new Date(),
        details: `Endpoint: ${endpoint}`
      });
      await user.save();
      pushEvents.emit('subscription:removed', {
        userId,
        endpoint
      });
      return { success: true, message: 'Subscription removed successfully' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Get user subscriptions
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
      // Return sanitized subscription data
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

  // Update subscription metrics
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
        // Count by browser
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

  // Cleanup expired subscriptions
  async cleanupExpiredSubscriptions() {
    try {
      console.log('Running push subscription cleanup...');
      // Find users with inactive subscriptions older than 30 days
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

  // Get service health status
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
      isInitialized: this.isInitialized
    };
  }

  // Test push service
  async testPushService(testSubscription = null) {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }
    try {
      // Use provided test subscription or create a mock one
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

  // Reset metrics
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
}

// Create singleton instance
const webPushService = new WebPushService();

// Enhanced web push service with additional utility methods
class EnhancedWebPushService extends WebPushService {
  // Send notification with custom actions
  async sendWithActions(userId, payload, actions, options = {}) {
    const enhancedPayload = {
      ...payload,
      actions: actions.map(action => ({
        action: action.id,
        title: action.title,
        icon: action.icon
      })),
      requireInteraction: true // Actions require interaction
    };
    return this.send(userId, enhancedPayload, options);
  }

  // Send silent notification (for background sync)
  async sendSilent(userId, data, options = {}) {
    const silentPayload = {
      title: '', // Empty title for silent notification
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
      TTL: 300 // 5 minutes for background sync
    });
  }

  // Send notification to specific browser
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

  // Send scheduled notification (client-side scheduling)
  async sendScheduled(userId, payload, scheduleTime, options = {}) {
    const delay = new Date(scheduleTime).getTime() - Date.now();
    if (delay <= 0) {
      return { success: false, error: 'Schedule time must be in the future' };
    }
    // For web push, we'll use showNotification with a timestamp
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
    // Send immediately but with timestamp for proper ordering
    return this.send(userId, scheduledPayload, options);
  }

  // Send rich notification with image and actions
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
}

// Export enhanced service instance
const enhancedWebPushService = new EnhancedWebPushService();

// Export both the enhanced service and event emitter
export default enhancedWebPushService;
// export { pushEvents };

// Export individual methods for direct use
export const addSubscription = (userId, subscription, metadata) =>
  enhancedWebPushService.addSubscription(userId, subscription, metadata);

export const send = (userId, payload, options) =>
  enhancedWebPushService.send(userId, payload, options);

export const sendBulk = (notificationList, options) =>
  enhancedWebPushService.sendBulk(notificationList, options);

export const sendWithActions = (userId, payload, actions, options) =>
  enhancedWebPushService.sendWithActions(userId, payload, actions, options);

export const sendSilent = (userId, data, options) =>
  enhancedWebPushService.sendSilent(userId, data, options);

export const sendToBrowser = (userId, browserType, payload, options) =>
  enhancedWebPushService.sendToBrowser(userId, browserType, payload, options);

export const sendRichNotification = (userId, payload, options) =>
  enhancedWebPushService.sendRichNotification(userId, payload, options);

export const removeSubscription = (userId, endpoint) =>
  enhancedWebPushService.removeSubscription(userId, endpoint);

export const getUserSubscriptions = (userId, activeOnly) =>
  enhancedWebPushService.getUserSubscriptions(userId, activeOnly);

export const testPushService = (testSubscription) =>
  enhancedWebPushService.testPushService(testSubscription);

export const getHealthStatus = () =>
  enhancedWebPushService.getHealthStatus();

// Client-side JavaScript for web push integration
export const generateClientScript = () => {
  return `
// Throne8 Web Push Client SDK
class Throne8WebPush {
  constructor(config) {
    this.config = {
      vapidPublicKey: '${PUSH_CONFIG.vapid.publicKey || ''}',
      apiEndpoint: '/api/notifications/push/subscribe',
      ...config
    };
    this.registration = null;
    this.subscription = null;
  }

  // Initialize service worker and request permission
  async initialize() {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service Worker not supported');
    }
    if (!('PushManager' in window)) {
      throw new Error('Push messaging not supported');
    }
    // Register service worker
    this.registration = await navigator.serviceWorker.register('/sw.js');
    // Wait for service worker to be ready
    await navigator.serviceWorker.ready;
    console.log('Throne8 Web Push initialized');
  }

  // Request notification permission
  async requestPermission() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('Notification permission denied');
    }
    return permission;
  }

  // Subscribe to push notifications
  async subscribe(userId) {
    if (!this.registration) {
      await this.initialize();
    }
    // Request permission
    await this.requestPermission();
    // Convert VAPID key
    const applicationServerKey = this.urlBase64ToUint8Array(this.config.vapidPublicKey);
    // Subscribe to push manager
    this.subscription = await this.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
    // Send subscription to server
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

  // Unsubscribe from push notifications
  async unsubscribe(userId) {
    if (!this.subscription) {
      return false;
    }
    const success = await this.subscription.unsubscribe();
    if (success) {
    console.log('Successfully unsubscribed from push notifications👏🏻👏🏻👏🏻');
      // Notify server
      await fetch('/api/notifications/push/unsubscribe', {
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

  // Check if user is subscribed
  async isSubscribed() {
    if (!this.registration) {
      return false;
    }
    this.subscription = await this.registration.pushManager.getSubscription();
    return !!this.subscription;
  }

  // Utility function to convert VAPID key
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

  // Handle notification click
  static handleNotificationClick(event) {
    console.log('Notification clicked:', event);
    event.notification.close();
    // Handle action clicks
    if (event.action) {
      switch (event.action) {
        case 'view':
          if (event.notification.data.url) {
            clients.openWindow(event.notification.data.url);
          }
          break;
        case 'dismiss':
          // Just close the notification
          break;
        default:
          console.log('Unknown action:', event.action);
      }
    } else {
      // Default click action
      if (event.notification.data.url) {
        clients.openWindow(event.notification.data.url);
      }
    }
  }

  // Handle background message
  static handleBackgroundMessage(event) {
    console.log('Background message received:', event);
    const notificationData = event.data.json();
    if (notificationData.silent) {
      // Handle silent notification (background sync)
      return; // Don't show notification
    }
    // Show notification
    const notificationOptions = {
      body: notificationData.body,
      icon: notificationData.icon,
      badge: notificationData.badge,
      image: notificationData.image,
      vibrate: notificationData.vibrate,
      data: notificationData.data,
      actions: notificationData.actions,
      requireInteraction: notificationData.requireInteraction,
      silent: notificationData.silent,
      tag: notificationData.tag,
      renotify: notificationData.renotify
    };
    return self.registration.showNotification(
      notificationData.title,
      notificationOptions
    );
  }
}

// Service Worker template
const serviceWorkerTemplate = \`
self.addEventListener('push', function(event) {
  if (!event.data) {
    return;
  }
  const notificationData = event.data.json();
  if (notificationData.silent) {
    // Handle background sync or silent notification
    return;
  }
  const notificationOptions = {
    body: notificationData.body,
    icon: notificationData.icon || '/icons/icon-192x192.png',
    badge: notificationData.badge || '/icons/badge-72x72.png',
    image: notificationData.image,
    vibrate: notificationData.vibrate || [200, 100, 200],
    data: notificationData.data || {},
    actions: notificationData.actions || [],
    requireInteraction: notificationData.requireInteraction || false,
    silent: notificationData.silent || false,
    tag: notificationData.tag || 'default',
    renotify: notificationData.renotify || false,
    timestamp: notificationData.timestamp || Date.now()
  };
  event.waitUntil(
    self.registration.showNotification(
      notificationData.title || 'Throne8 Notification',
      notificationOptions
    )
  );
});

self.addEventListener('notificationclick', function(event) {
  console.log('Notification clicked:', event);
  event.notification.close();
  const clickAction = event.action || 'default';
  const notificationData = event.notification.data || {};
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        // Handle different actions
        switch (clickAction) {
          case 'view':
          case 'default':
            const url = notificationData.url || '/';
            // Try to focus existing window
            for (let i = 0; i < clientList.length; i++) {
              const client = clientList[i];
              if (client.url.includes(url) && 'focus' in client) {
                return client.focus();
              }
            }
            // Open new window
            if (clients.openWindow) {
              return clients.openWindow(url);
            }
            break;
          case 'dismiss':
            // Just close the notification (already done above)
            break;
          default:
            console.log('Unknown notification action:', clickAction);
        }
      })
  );
});

self.addEventListener('notificationclose', function(event) {
  console.log('Notification closed:', event);
  // Track notification dismissal if needed
  const notificationData = event.notification.data || {};
  if (notificationData.trackDismissal) {
    // Send analytics event
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

// Background sync for offline support
self.addEventListener('sync', function(event) {
  if (event.tag === 'throne8-sync') {
    event.waitUntil(
      // Perform background sync operations
      fetch('/api/sync')
        .then(response => response.json())
        .then(data => {
          if (data.notifications) {
            // Show any pending notifications
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
\`;

// Make Throne8WebPush available globally
window.Throne8WebPush = Throne8WebPush;

// Auto-generate service worker file
if (typeof window !== 'undefined' && window.location.pathname === '/sw.js') {
  // Return service worker content
  const response = new Response(serviceWorkerTemplate, {
    headers: { 'Content-Type': 'application/javascript' }
  });
  return response;
}
`;
};

// Express middleware for serving client script
export const serveClientScript = (req, res) => {
  const script = generateClientScript();
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
  res.send(script);
};

// Express middleware for serving service worker
export const serveServiceWorker = (req, res) => {
  const serviceWorker = `
// Throne8 Push Service Worker
self.addEventListener('push', function(event) {
  if (!event.data) return;
  const data = event.data.json();
  if (data.silent) return; // Silent notifications
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
`;

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
  res.send(serviceWorker);
};