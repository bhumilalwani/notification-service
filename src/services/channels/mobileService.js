import DeviceToken from '../../models/DeviceToken.js';
import NotificationUser from '../../models/User.js';
import path from 'path';
import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import crypto from 'crypto';

// Dynamic imports for better compatibility
let adminLib;
let webpush;

// Event emitter for mobile push events
export const mobileEvents = new EventEmitter();

// Mobile service configuration
const MOBILE_CONFIG = {
  firebase: {
    maxTokensPerUser: 10, // Limit tokens per user
    maxRetries: 3,
    retryDelay: 1000,
    batchSize: 500, // FCM multicast limit
    timeToLive: 2419200, // 28 days in seconds
    dryRun: process.env.NODE_ENV === 'test'
  },
  apns: {
    production: process.env.NODE_ENV === 'production',
    maxConnections: 10,
    maxRetries: 3
  },
  webpush: {
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@throne8.com',
    gcmAPIKey: process.env.GCM_API_KEY,
    ttl: 24 * 60 * 60 // 24 hours in seconds
  },
  huawei: {
    appId: process.env.HUAWEI_APP_ID,
    appSecret: process.env.HUAWEI_APP_SECRET,
    tokenUrl: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token'
  }
};

class MobileService {
  constructor() {
    this.firebaseAdmin = null;
    this.webPush = null;
    this.huaweiToken = null;
    this.huaweiTokenExpiry = null;
    this.isInitialized = false;
    this.providers = new Set();
    this.metrics = {
      sent: 0,
      delivered: 0,
      failed: 0,
      invalidTokens: 0,
      byPlatform: {
        android: { sent: 0, failed: 0 },
        ios: { sent: 0, failed: 0 },
        web: { sent: 0, failed: 0 },
        huawei: { sent: 0, failed: 0 }
      }
    };
    this.initialize();
  }

  // Initialize mobile push services
  async initialize() {
    try {
      // Initialize Firebase Admin SDK
      await this.initializeFirebase();
      // Initialize Web Push
      await this.initializeWebPush();
      // Initialize Huawei Push
    //   await this.initializeHuawei();
      this.isInitialized = true;
      console.log(`Mobile service initialized with providers: ${Array.from(this.providers).join(', ')}`);
      // Setup token cleanup job
      this.setupTokenCleanup();
      // Setup metrics reporting
      this.setupMetricsReporting();
    } catch (error) {
      console.error('Failed to initialize mobile service:', error);
      this.isInitialized = false;
    }
  }

  // Initialize Firebase Admin SDK
 // Initialize Firebase Admin SDK
async initializeFirebase() {
  try {
    // Dynamic import for better compatibility
    if (!adminLib) {
      adminLib = await import('firebase-admin');
      adminLib = adminLib.default;
    }

    // Check if already initialized
    if (this.firebaseAdmin) {
      return this.firebaseAdmin;
    }

    const saPath = process.env.FIREBASE_SA_PATH;
    const serviceAccountJson = process.env.FIREBASE_SA_JSON;
    let credential;

    if (serviceAccountJson) {
      // Use JSON string from environment variable
      const serviceAccount = JSON.parse(serviceAccountJson);
      credential = adminLib.credential.cert(serviceAccount);
    } else if (saPath) {
      // Use service account file path
      const resolvedPath = path.resolve(saPath);
      const serviceAccount = JSON.parse(readFileSync(resolvedPath, 'utf8'));
      credential = adminLib.credential.cert(serviceAccount);
    } else {
      // Try to use default application credentials
      console.warn('No Firebase credentials configured, trying default application credentials');
      credential = adminLib.credential.applicationDefault();
    }

    // Initialize Firebase app
    const firebaseConfig = {
      credential,
      projectId: process.env.FIREBASE_PROJECT_ID
    };

    // Check if app already exists
    try {
      this.firebaseAdmin = adminLib.app();
    } catch (error) {
      this.firebaseAdmin = adminLib.initializeApp(firebaseConfig);
    }

    // REMOVE THIS ENTIRE TEST SECTION:
    // await this.firebaseAdmin.messaging().send({
    //   token: 'test-token',
    //   notification: { title: 'test', body: 'test' }
    // }, true); // dry run

    this.providers.add('firebase');
    console.log('Firebase Admin SDK initialized successfully');
    return this.firebaseAdmin;

  } catch (error) {
    console.error('Firebase initialization failed:', error.message);
    // Don't throw, allow other providers to initialize
  }
}
  // Initialize Web Push
  async initializeWebPush() {
    try {
      // Dynamic import for better compatibility
      if (!webpush) {
        const webpushModule = await import('web-push');
        webpush = webpushModule.default;
      }
      const { vapidPublicKey, vapidPrivateKey, vapidSubject } = MOBILE_CONFIG.webpush;
      if (!vapidPublicKey || !vapidPrivateKey) {
        console.warn('VAPID keys not configured, web push disabled');
        return;
      }
      // Set VAPID details
      webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
      // Set GCM API key if available
      if (MOBILE_CONFIG.webpush.gcmAPIKey) {
        webpush.setGCMAPIKey(MOBILE_CONFIG.webpush.gcmAPIKey);
      }
      this.webPush = webpush;
      this.providers.add('webpush');
      console.log('Web Push initialized successfully');
    } catch (error) {
      console.error('Web Push initialization failed:', error.message);
    }
  }

//   // Initialize Huawei Push
//   async initializeHuawei() {
//     try {
//       const { appId, appSecret } = MOBILE_CONFIG.huawei;
//       if (!appId || !appSecret) {
//         console.warn('Huawei credentials not configured, Huawei push disabled');
//         return;
//       }
//       // Get access token
//       await this.refreshHuaweiToken();
//       this.providers.add('huawei');
//       console.log('Huawei Push initialized successfully');
//     } catch (error) {
//       console.error('Huawei Push initialization failed:', error.message);
//     }
//   }

  // Refresh Huawei access token
//   async refreshHuaweiToken() {
//     const { appId, appSecret, tokenUrl } = MOBILE_CONFIG.huawei;
//     try {
//       const response = await fetch(tokenUrl, {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/x-www-form-urlencoded'
//         },
//         body: new URLSearchParams({
//           grant_type: 'client_credentials',
//           client_id: appId,
//           client_secret: appSecret
//         })
//       });
//       const data = await response.json();
//       if (data.access_token) {
//         this.huaweiToken = data.access_token;
//         this.huaweiTokenExpiry = Date.now() + (data.expires_in * 1000);
//         console.log('Huawei token refreshed successfully');
//       } else {
//         throw new Error('Invalid token response');
//       }
//     } catch (error) {
//       console.error('Failed to refresh Huawei token:', error);
//       throw error;
//     }
//   }

  // Register device token with enhanced validation and deduplication
  async registerToken(userId, platform, token, deviceInfo = {}) {
    try {
      if (!userId || !platform || !token) {
        throw new Error('Missing required parameters: userId, platform, token');
      }
      // Validate platform
      const validPlatforms = ['android', 'ios', 'web', 'desktop', 'watch'];
      if (!validPlatforms.includes(platform)) {
        throw new Error(`Invalid platform: ${platform}. Must be one of ${validPlatforms.join(', ')}`);
      }
      // Validate token format based on platform
      if (!this.isValidTokenFormat(token, platform)) {
        throw new Error(`Invalid token format for platform: ${platform}`);
      }
      // Check if token already exists for different user
      const existingToken = await DeviceToken.findByToken(token, platform);
      if (existingToken && existingToken.userId !== userId) {
        // Deactivate old token
        await existingToken.deactivate('token_transferred');
      }
      // Get or create user
      let user = await NotificationUser.findOne({ userId });
      if (!user) {
        user = new NotificationUser({
          userId,
          preferences: { enabled: true }
        });
        await user.save();
      }
      // Determine provider service
      const providerService = this.determineProviderService(platform, token);
      // Prepare token data
      const tokenData = {
        userId,
        platform,
        token,
        deviceInfo: {
          ...deviceInfo,
          registeredAt: new Date(),
          lastSeen: new Date()
        },
        provider: {
          service: providerService,
          ...deviceInfo.provider
        },
        status: 'active'
      };
      // Check user's token limit
      const userTokenCount = await DeviceToken.countDocuments({
        userId,
        status: 'active',
        'deletion.isDeleted': false
      });
      if (userTokenCount >= MOBILE_CONFIG.firebase.maxTokensPerUser) {
        // Remove oldest token
        const oldestToken = await DeviceToken.findOne({
          userId,
          status: 'active',
          'deletion.isDeleted': false
        }).sort({ createdAt: 1 });
        if (oldestToken) {
          await oldestToken.deactivate('token_limit_exceeded');
        }
      }
      // Create or update token
      const deviceToken = await DeviceToken.findOneAndUpdate(
        { userId, platform, token },
        tokenData,
        { 
          upsert: true, 
          new: true,
          setDefaultsOnInsert: true
        }
      );
      // Validate token with provider
      const validationResult = await this.validateTokenWithProvider(deviceToken);
      if (!validationResult.valid) {
        await deviceToken.recordNotificationFailed(validationResult.error);
      }
      // Emit registration event
      mobileEvents.emit('token:registered', {
        userId,
        platform,
        tokenId: deviceToken.tokenId,
        provider: providerService
      });
      console.log(`Device token registered: ${platform} for user ${userId}`);
      return {
        success: true,
        tokenId: deviceToken.tokenId,
        platform,
        provider: providerService
      };
    } catch (error) {
      console.error('Token registration failed:', error);
      mobileEvents.emit('token:registration_failed', {
        userId,
        platform,
        error: error.message
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Validate token format based on platform
  isValidTokenFormat(token, platform) {
    switch (platform) {
      case 'android':
        // FCM tokens are typically 152+ characters
        return token.length >= 140 && /^[A-Za-z0-9_-]+$/.test(token);
      case 'ios':
        // APNS tokens can vary but are typically 64 hex characters or longer
        return token.length >= 60;
      case 'web':
        // Web push endpoints are URLs
        return token.startsWith('https://');
      default:
        return token.length > 10; // Basic validation
    }
  }

  // Determine provider service based on platform and token
  determineProviderService(platform, token) {
    switch (platform) {
      case 'android':
        if (token.includes('huawei')) return 'huawei';
        return 'fcm';
      case 'ios':
        return 'apns';
      case 'web':
        if (token.includes('fcm.googleapis.com')) return 'fcm';
        if (token.includes('updates.push.services.mozilla.com')) return 'mozilla';
        if (token.includes('wns.windows.com')) return 'wns';
        return 'web-push';
      default:
        return 'fcm';
    }
  }

  // Validate token with provider
  async validateTokenWithProvider(deviceToken) {
    try {
      switch (deviceToken.provider.service) {
        case 'fcm':
        case 'apns':
          return await this.validateFirebaseToken(deviceToken);
        case 'web-push':
          return await this.validateWebPushToken(deviceToken);
        case 'huawei':
          return await this.validateHuaweiToken(deviceToken);
        default:
          return { valid: true }; // Skip validation for unknown providers
      }
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // Validate Firebase token
  async validateFirebaseToken(deviceToken) {
    if (!this.firebaseAdmin) {
      return { valid: false, error: 'Firebase not initialized' };
    }
    try {
      // Send a test message in dry run mode
      await this.firebaseAdmin.messaging().send({
        token: deviceToken.token,
        notification: {
          title: 'Validation',
          body: 'Token validation test'
        }
      }, true); // dry run
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // Validate Web Push token
  async validateWebPushToken(deviceToken) {
    if (!this.webPush) {
      return { valid: false, error: 'Web Push not initialized' };
    }
    try {
      // For web push, we'll consider it valid if it has the right structure
      const subscription = {
        endpoint: deviceToken.token,
        keys: deviceToken.provider.keys || {}
      };
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // Validate Huawei token
  async validateHuaweiToken(deviceToken) {
    try {
      // Basic validation for Huawei tokens
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // Main send function with multi-provider support
  async send(userId, payload, options = {}) {
    if (!this.isInitialized) {
      console.warn('Mobile service not initialized');
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
      // Get active device tokens
      const deviceTokens = await DeviceToken.findActiveByUser(userId);
      if (!deviceTokens.length) {
        return { success: false, error: 'No active device tokens found' };
      }
      // Group tokens by provider
      const tokensByProvider = this.groupTokensByProvider(deviceTokens);
      // Send notifications through each provider
      const results = {};
      const allResults = [];
      for (const [provider, tokens] of Object.entries(tokensByProvider)) {
        try {
          const providerResult = await this.sendByProvider(provider, tokens, payload, options);
          results[provider] = providerResult;
          allResults.push(...providerResult.results);
        } catch (error) {
          console.error(`Provider ${provider} failed:`, error);
          results[provider] = { success: false, error: error.message, results: [] };
        }
      }
      // Update metrics
      const successCount = allResults.filter(r => r.success).length;
      const failCount = allResults.filter(r => !r.success).length;
      this.metrics.sent += successCount;
      this.metrics.failed += failCount;
      // Update user metrics
      if (successCount > 0) {
        await user.recordNotificationReceived('push');
      }
      // Emit send event
      mobileEvents.emit('notification:sent', {
        userId,
        payload: payload.title,
        providers: Object.keys(tokensByProvider),
        success: successCount,
        failed: failCount
      });
      const overallSuccess = successCount > 0;
      return {
        success: overallSuccess,
        totalTokens: deviceTokens.length,
        sentTo: successCount,
        failed: failCount,
        results: allResults,
        providerResults: results
      };
    } catch (error) {
      console.error('Mobile send error:', error);
      this.metrics.failed++;
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Group tokens by provider for efficient sending
  groupTokensByProvider(deviceTokens) {
    const groups = {};
    for (const token of deviceTokens) {
      const provider = token.provider.service;
      if (!groups[provider]) {
        groups[provider] = [];
      }
      groups[provider].push(token);
    }
    return groups;
  }

  // Send notifications by provider
  async sendByProvider(provider, tokens, payload, options) {
    switch (provider) {
      case 'fcm':
      case 'apns':
        return await this.sendFirebase(tokens, payload, options);
      case 'web-push':
        return await this.sendWebPush(tokens, payload, options);
      case 'huawei':
        return await this.sendHuawei(tokens, payload, options);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  // Send via Firebase (FCM/APNS)
  async sendFirebase(tokens, payload, options) {
    if (!this.firebaseAdmin) {
      throw new Error('Firebase not initialized');
    }
    const results = [];
    const { batchSize } = MOBILE_CONFIG.firebase;
    // Prepare message
    const message = this.buildFirebaseMessage(payload, options);
    // Process tokens in batches
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      const tokenStrings = batch.map(t => t.token);
      try {
        // Use multicast for efficiency
        const response = await this.firebaseAdmin.messaging().sendMulticast({
          ...message,
          tokens: tokenStrings
        });
        // Process individual results
        response.responses.forEach((result, index) => {
          const deviceToken = batch[index];
          if (result.success) {
            results.push({
              success: true,
              tokenId: deviceToken.tokenId,
              messageId: result.messageId,
              platform: deviceToken.platform
            });
            // Update token metrics
            deviceToken.recordNotificationSent();
            this.metrics.byPlatform[deviceToken.platform].sent++;
          } else {
            results.push({
              success: false,
              tokenId: deviceToken.tokenId,
              error: result.error?.message || 'Unknown error',
              errorCode: result.error?.code,
              platform: deviceToken.platform
            });
            // Handle specific errors
            this.handleFirebaseError(deviceToken, result.error);
            this.metrics.byPlatform[deviceToken.platform].failed++;
          }
        });
      } catch (error) {
        console.error('Firebase batch send failed:', error);
        // Mark all tokens in batch as failed
        batch.forEach(deviceToken => {
          results.push({
            success: false,
            tokenId: deviceToken.tokenId,
            error: error.message,
            platform: deviceToken.platform
          });
          this.metrics.byPlatform[deviceToken.platform].failed++;
        });
      }
    }
    return {
      success: results.some(r => r.success),
      results,
      provider: 'firebase'
    };
  }

  // Build Firebase message
  buildFirebaseMessage(payload, options = {}) {
    const message = {
      notification: {
        title: payload.title,
        body: payload.body
      },
      data: {
        notificationId: payload.notificationId || '',
        type: payload.type || 'general',
        ...(payload.data || {})
      },
      android: {
        priority: 'high',
        notification: {
          channelId: payload.type || 'default',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true
        },
        ttl: MOBILE_CONFIG.firebase.timeToLive * 1000
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + MOBILE_CONFIG.firebase.timeToLive)
        },
        payload: {
          aps: {
            alert: {
              title: payload.title,
              body: payload.body
            },
            sound: 'default',
            badge: payload.badge || 1,
            category: payload.type || 'default'
          }
        }
      }
    };
    // Add custom sound if specified
    if (payload.sound) {
      message.android.notification.sound = payload.sound;
      message.apns.payload.aps.sound = payload.sound;
    }
    // Add actions if specified
    if (payload.actions && payload.actions.length > 0) {
      message.android.notification.clickAction = 'FLUTTER_NOTIFICATION_CLICK';
      message.apns.payload.aps.category = 'ACTIONABLE';
    }
    // Add image if specified
    if (payload.image) {
      message.android.notification.image = payload.image;
      message.apns.payload.aps['mutable-content'] = 1;
    }
    return message;
  }

  // Handle Firebase errors
  async handleFirebaseError(deviceToken, error) {
    const errorCode = error?.code;
    switch (errorCode) {
      case 'messaging/invalid-registration-token':
      case 'messaging/registration-token-not-registered':
        // Token is invalid, deactivate it
        await deviceToken.deactivate('invalid_token');
        this.metrics.invalidTokens++;
        break;
      case 'messaging/message-rate-exceeded':
        // Rate limit exceeded, don't retry immediately
        console.warn('Firebase rate limit exceeded');
        break;
      default:
        // Record failure for retry logic
        await deviceToken.recordNotificationFailed(error?.message);
        break;
    }
  }

  // Send via Web Push
  async sendWebPush(tokens, payload, options) {
    if (!this.webPush) {
      throw new Error('Web Push not initialized');
    }
    const results = [];
    for (const deviceToken of tokens) {
      try {
        const subscription = {
          endpoint: deviceToken.token,
          keys: deviceToken.provider.keys || {}
        };
        const webPushPayload = JSON.stringify({
          title: payload.title,
          body: payload.body,
          icon: payload.icon || '/icon-192x192.png',
          badge: payload.badge || '/badge-72x72.png',
          image: payload.image,
          data: {
            notificationId: payload.notificationId,
            type: payload.type,
            ...(payload.data || {})
          },
          actions: payload.actions || [],
          requireInteraction: payload.priority === 'high',
          silent: payload.silent || false
        });
        const pushOptions = {
          TTL: MOBILE_CONFIG.webpush.ttl,
          vapidDetails: {
            subject: MOBILE_CONFIG.webpush.vapidSubject,
            publicKey: MOBILE_CONFIG.webpush.vapidPublicKey,
            privateKey: MOBILE_CONFIG.webpush.vapidPrivateKey
          }
        };
        await this.webPush.sendNotification(subscription, webPushPayload, pushOptions);
        results.push({
          success: true,
          tokenId: deviceToken.tokenId,
          platform: deviceToken.platform
        });
        await deviceToken.recordNotificationSent();
        this.metrics.byPlatform.web.sent++;
      } catch (error) {
        results.push({
          success: false,
          tokenId: deviceToken.tokenId,
          error: error.message,
          statusCode: error.statusCode,
          platform: deviceToken.platform
        });
        // Handle Web Push specific errors
        if (error.statusCode === 410) {
          // Subscription expired
          await deviceToken.deactivate('subscription_expired');
        } else {
          await deviceToken.recordNotificationFailed(error.message);
        }
        this.metrics.byPlatform.web.failed++;
      }
    }
    return {
      success: results.some(r => r.success),
      results,
      provider: 'web-push'
    };
  }

  // Send via Huawei Push
//   async sendHuawei(tokens, payload, options) {
//     // Check and refresh token if needed
//     if (!this.huaweiToken || Date.now() >= this.huaweiTokenExpiry) {
//       await this.refreshHuaweiToken();
//     }
//     const results = [];
//     for (const deviceToken of tokens) {
//       try {
//         const huaweiMessage = {
//           validate_only: false,
//           message: {
//             android: {
//               notification: {
//                 title: payload.title,
//                 body: payload.body,
//                 click_action: {
//                   type: 1,
//                   intent: payload.data?.url || '#'
//                 }
//               },
//               data: JSON.stringify(payload.data || {})
//             },
//             token: [deviceToken.token]
//           }
//         };
//         const response = await fetch(
//           `https://push-api.cloud.huawei.com/v1/${MOBILE_CONFIG.huawei.appId}/messages:send`,
//           {
//             method: 'POST',
//             headers: {
//               'Authorization': `Bearer ${this.huaweiToken}`,
//               'Content-Type': 'application/json'
//             },
//             body: JSON.stringify(huaweiMessage)
//           }
//         );
//         const responseData = await response.json();
//         if (response.ok && responseData.code === '80000000') {
//           results.push({
//             success: true,
//             tokenId: deviceToken.tokenId,
//             messageId: responseData.requestId,
//             platform: deviceToken.platform
//           });
//           await deviceToken.recordNotificationSent();
//           this.metrics.byPlatform.huawei.sent++;
//         } else {
//           throw new Error(responseData.msg || 'Huawei send failed');
//         }
//       } catch (error) {
//         results.push({
//           success: false,
//           tokenId: deviceToken.tokenId,
//           error: error.message,
//           platform: deviceToken.platform
//         });
//         await deviceToken.recordNotificationFailed(error.message);
//         this.metrics.byPlatform.huawei.failed++;
//       }
//     }
//     return {
//       success: results.some(r => r.success),
//       results,
//       provider: 'huawei'
//     };
//   }

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

  // Setup automatic token cleanup
  setupTokenCleanup() {
    // Run cleanup every 24 hours
    setInterval(async () => {
      try {
        console.log('Running device token cleanup...');
        // Clean up expired tokens
        const expiredResult = await DeviceToken.cleanupExpiredTokens();
        console.log(`Cleaned up ${expiredResult.modifiedCount} expired tokens`);
        // Clean up inactive tokens (30 days)
        const inactiveTokens = await DeviceToken.findInactiveTokens(30, 100);
        for (const token of inactiveTokens) {
          await token.deactivate('inactive');
        }
        console.log(`Deactivated ${inactiveTokens.length} inactive tokens`);
        // Emit cleanup event
        mobileEvents.emit('cleanup:completed', {
          expired: expiredResult.modifiedCount,
          inactive: inactiveTokens.length,
          timestamp: new Date()
        });
      } catch (error) {
        console.error('Token cleanup error:', error);
        mobileEvents.emit('cleanup:error', {
          error: error.message,
          timestamp: new Date()
        });
      }
    }, 24 * 60 * 60 * 1000); // 24 hours
  }

  // Setup metrics reporting
  setupMetricsReporting() {
    // Report metrics every hour
    setInterval(() => {
      console.log('Mobile service metrics:', this.metrics);
      mobileEvents.emit('metrics:hourly', {
        ...this.metrics,
        timestamp: new Date(),
        providers: Array.from(this.providers)
      });
    }, 60 * 60 * 1000); // 1 hour
  }

  // Get service health status
  getHealthStatus() {
    const totalSent = this.metrics.sent + this.metrics.failed;
    const successRate = totalSent > 0 ? (this.metrics.sent / totalSent) * 100 : 100;
    const platformHealth = {};
    Object.entries(this.metrics.byPlatform).forEach(([platform, metrics]) => {
      const platformTotal = metrics.sent + metrics.failed;
      platformHealth[platform] = {
        ...metrics,
        successRate: platformTotal > 0 ? (metrics.sent / platformTotal) * 100 : 100
      };
    });
    return {
      status: this.isInitialized ? 'healthy' : 'unhealthy',
      providers: Array.from(this.providers),
      metrics: {
        ...this.metrics,
        successRate: Math.round(successRate * 100) / 100
      },
      platformHealth,
      firebase: {
        initialized: !!this.firebaseAdmin,
        projectId: process.env.FIREBASE_PROJECT_ID
      },
      webpush: {
        initialized: !!this.webPush,
        hasVapidKeys: !!(MOBILE_CONFIG.webpush.vapidPublicKey && MOBILE_CONFIG.webpush.vapidPrivateKey)
      },
    //   huawei: {
    //     initialized: !!this.huaweiToken,
    //     tokenExpiry: this.huaweiTokenExpiry
    //   },
      isInitialized: this.isInitialized
    };
  }

  // Test push notification
  async testPushNotification(platform = 'android', testToken = null) {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }
    try {
      // Use provided test token or get from environment
      const token = testToken || process.env[`TEST_TOKEN_${platform.toUpperCase()}`];
      if (!token) {
        return { 
          success: false, 
          error: `No test token available for platform: ${platform}` 
        };
      }
      const testPayload = {
        title: 'Test Notification - Throne8',
        body: 'This is a test push notification from Throne8 mobile service.',
        type: 'system',
        priority: 'low',
        data: {
          test: true,
          timestamp: new Date().toISOString(),
          platform
        }
      };
      // Create temporary device token for testing
      const testDeviceToken = {
        token,
        platform,
        provider: {
          service: this.determineProviderService(platform, token)
        },
        recordNotificationSent: async () => {},
        recordNotificationFailed: async () => {}
      };
      // Send test notification
      const result = await this.sendByProvider(
        testDeviceToken.provider.service,
        [testDeviceToken],
        testPayload,
        { test: true }
      );
      return {
        success: result.success,
        platform,
        provider: testDeviceToken.provider.service,
        result: result.results[0],
        timestamp: new Date()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        platform,
        timestamp: new Date()
      };
    }
  }

  // Remove device token
  async removeToken(userId, token) {
    try {
      const deviceToken = await DeviceToken.findOne({
        userId,
        token,
        'deletion.isDeleted': false
      });
      if (!deviceToken) {
        return { success: false, error: 'Token not found' };
      }
      await deviceToken.softDelete('user_request');
      mobileEvents.emit('token:removed', {
        userId,
        tokenId: deviceToken.tokenId,
        platform: deviceToken.platform
      });
      return { success: true, message: 'Token removed successfully' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Get user's device tokens
  async getUserTokens(userId, activeOnly = true) {
    try {
      const query = { userId };
      if (activeOnly) {
        query.status = 'active';
        query['deletion.isDeleted'] = false;
      }
      const tokens = await DeviceToken.find(query)
        .select('tokenId platform status deviceInfo.deviceName createdAt metrics')
        .lean();
      return {
        success: true,
        tokens,
        count: tokens.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Update device token info
  async updateTokenInfo(tokenId, updateData) {
    try {
      const deviceToken = await DeviceToken.findOne({ tokenId });
      if (!deviceToken) {
        return { success: false, error: 'Token not found' };
      }
      // Update allowed fields
      const allowedFields = ['deviceInfo', 'preferences'];
      const updateDoc = {};
      allowedFields.forEach(field => {
        if (updateData[field]) {
          updateDoc[field] = { ...deviceToken[field], ...updateData[field] };
        }
      });
      await deviceToken.updateOne(updateDoc);
      return { success: true, message: 'Token updated successfully' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Handle delivery status webhook
  async handleDeliveryWebhook(provider, payload) {
    try {
      let tokenId, status, error;
      switch (provider) {
        case 'firebase':
          // Handle Firebase delivery receipts
          tokenId = payload.registration_token;
          status = payload.event_type === 'delivered' ? 'delivered' : 'failed';
          error = payload.error;
          break;
        case 'huawei':
          // Handle Huawei delivery receipts
          tokenId = payload.device_token;
          status = payload.status === 0 ? 'delivered' : 'failed';
          error = payload.error_msg;
          break;
        default:
          console.warn(`Unknown mobile provider webhook: ${provider}`);
          return { success: false, error: 'Unknown provider' };
      }
      if (tokenId && status) {
        // Find device token and update metrics
        const deviceToken = await DeviceToken.findOne({ token: tokenId });
        if (deviceToken) {
          if (status === 'delivered') {
            await deviceToken.recordNotificationDelivered();
            this.metrics.delivered++;
          } else {
            await deviceToken.recordNotificationFailed(error);
          }
          // Emit delivery event
          mobileEvents.emit('delivery:update', {
            tokenId: deviceToken.tokenId,
            status,
            error,
            provider,
            timestamp: new Date()
          });
        }
        return { success: true, status, tokenId };
      }
      return { success: false, error: 'Invalid webhook payload' };
    } catch (error) {
      console.error('Mobile webhook processing error:', error);
      return { success: false, error: error.message };
    }
  }

  // Reset metrics
  resetMetrics() {
    this.metrics = {
      sent: 0,
      delivered: 0,
      failed: 0,
      invalidTokens: 0,
      byPlatform: {
        android: { sent: 0, failed: 0 },
        ios: { sent: 0, failed: 0 },
        web: { sent: 0, failed: 0 },
        // huawei: { sent: 0, failed: 0 }
      }
    };
  }

  // Graceful shutdown
  async shutdown() {
    try {
      console.log('Shutting down mobile service...');
      // Close Firebase connection
      if (this.firebaseAdmin) {
        await this.firebaseAdmin.delete();
        console.log('Firebase Admin SDK connection closed');
      }
      this.isInitialized = false;
      console.log('Mobile service shutdown complete');
    } catch (error) {
      console.error('Mobile service shutdown error:', error);
    }
  }
}

// Create singleton instance
const mobileService = new MobileService();

// Handle process shutdown
process.on('SIGTERM', () => {
  mobileService.shutdown();
});

process.on('SIGINT', () => {
  mobileService.shutdown();
});

// Enhanced mobile service with additional utility methods
class EnhancedMobileService extends MobileService {
  // Send targeted notification to specific platforms
  async sendToPlatforms(userId, platforms, payload, options = {}) {
    const deviceTokens = await DeviceToken.find({
      userId,
      platform: { $in: platforms },
      status: 'active',
      'deletion.isDeleted': false
    });
    if (!deviceTokens.length) {
      return { success: false, error: 'No active tokens for specified platforms' };
    }
    const tokensByProvider = this.groupTokensByProvider(deviceTokens);
    const results = {};
    for (const [provider, tokens] of Object.entries(tokensByProvider)) {
      results[provider] = await this.sendByProvider(provider, tokens, payload, options);
    }
    return {
      success: Object.values(results).some(r => r.success),
      platforms,
      results
    };
  }

  // Send location-based notification
  async sendToLocation(country, region, payload, options = {}) {
    const deviceTokens = await DeviceToken.find({
      'location.country': country,
      'location.region': region || { $exists: true },
      status: 'active',
      'deletion.isDeleted': false
    }).populate('userId');
    const userIds = [...new Set(deviceTokens.map(t => t.userId))];
    const results = [];
    for (const userId of userIds) {
      const result = await this.send(userId, payload, options);
      results.push({ userId, result });
    }
    return {
      success: true,
      targetLocation: { country, region },
      usersTargeted: userIds.length,
      results
    };
  }

  // Send based on device characteristics
  async sendToDeviceType(deviceType, osVersion, payload, options = {}) {
    const deviceTokens = await DeviceToken.find({
      'deviceInfo.deviceType': deviceType,
      'deviceInfo.osVersion': { $regex: osVersion, $options: 'i' },
      status: 'active',
      'deletion.isDeleted': false
    });
    const userIds = [...new Set(deviceTokens.map(t => t.userId))];
    const results = [];
    for (const userId of userIds) {
      const result = await this.send(userId, payload, options);
      results.push({ userId, result });
    }
    return {
      success: true,
      targetCriteria: { deviceType, osVersion },
      usersTargeted: userIds.length,
      results
    };
  }

  // Send emergency notification (bypasses user preferences)
  async sendEmergency(userId, payload, options = {}) {
    // Force emergency settings
    const emergencyOptions = {
      ...options,
      bypassPreferences: true,
      priority: 'critical',
      requireInteraction: true
    };
    // Add emergency styling to payload
    const emergencyPayload = {
      ...payload,
      priority: 'critical',
      type: 'emergency',
      sound: 'emergency',
      vibration: [500, 200, 500, 200, 500]
    };
    return await this.send(userId, emergencyPayload, emergencyOptions);
  }

  // Schedule push notification
  async schedulePushNotification(userId, payload, scheduleTime, options = {}) {
    const delay = new Date(scheduleTime).getTime() - Date.now();
    if (delay <= 0) {
      return { success: false, error: 'Schedule time must be in the future' };
    }
    // Use setTimeout for short delays (< 24 hours)
    if (delay < 24 * 60 * 60 * 1000) {
      setTimeout(async () => {
        try {
          await this.send(userId, payload, options);
          mobileEvents.emit('scheduled:sent', { userId, scheduleTime });
        } catch (error) {
          console.error('Scheduled notification failed:', error);
          mobileEvents.emit('scheduled:failed', { userId, scheduleTime, error: error.message });
        }
      }, delay);
      return {
        success: true,
        message: 'Notification scheduled successfully',
        scheduleTime,
        userId
      };
    } else {
      // For longer delays, you might want to use a job queue like Bull or Agenda
      return {
        success: false,
        error: 'Schedule time too far in future. Use job queue for long-term scheduling.'
      };
    }
  }
}

// Export enhanced service instance
const enhancedMobileService = new EnhancedMobileService();

// Export both the enhanced service and event emitter
export default enhancedMobileService;
// export { mobileEvents };

// Export individual methods for direct use
export const registerToken = (userId, platform, token, deviceInfo) => 
  enhancedMobileService.registerToken(userId, platform, token, deviceInfo);

export const send = (userId, payload, options) => 
  enhancedMobileService.send(userId, payload, options);

export const sendBulk = (notificationList, options) => 
  enhancedMobileService.sendBulk(notificationList, options);

export const sendToPlatforms = (userId, platforms, payload, options) => 
  enhancedMobileService.sendToPlatforms(userId, platforms, payload, options);

export const sendEmergency = (userId, payload, options) => 
  enhancedMobileService.sendEmergency(userId, payload, options);

export const removeToken = (userId, token) => 
  enhancedMobileService.removeToken(userId, token);

export const getUserTokens = (userId, activeOnly) => 
  enhancedMobileService.getUserTokens(userId, activeOnly);

export const testPushNotification = (platform, testToken) => 
  enhancedMobileService.testPushNotification(platform, testToken);

export const getHealthStatus = () => 
  enhancedMobileService.getHealthStatus();

export const handleDeliveryWebhook = (provider, payload) => 
  enhancedMobileService.handleDeliveryWebhook(provider, payload);