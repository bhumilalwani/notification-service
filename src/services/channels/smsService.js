import { EventEmitter } from 'events';
import NotificationUser from '../../models/User.js'; // Adjust path as needed
import twilio from 'twilio';
import winston from 'winston';

// Event emitter for SMS events
export const smsEvents = new EventEmitter();

// SMS service configuration
const SMS_CONFIG = {
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER || '7987986868', // Default Twilio number
  },
  settings: {
    ttl: 24 * 60 * 60, // 24 hours in seconds
    maxMessagesPerUser: 50, // Max SMS per user per day
    retryAttempts: 3,
    retryDelay: 1000, // 1 second
    batchSize: 100, // Max users to process at once
    urgentTTL: 60, // 1 minute for urgent messages
    timeout: 30000, // 30 seconds request timeout
  },
  defaults: {
    priority: 'medium',
    maxLength: 160, // Standard SMS character limit
  },
};

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/smsService.log' }),
  ],
});

class SMSService {
  constructor() {
    this.isInitialized = false;
    this.client = null;
    this.metrics = {
      sent: 0,
      delivered: 0,
      failed: 0,
      byProvider: {
        twilio: 0,
        other: 0,
      },
    };
    this.initialize();
  }

  // Initialize SMS service
  initialize() {
    try {
      const { accountSid, authToken, fromNumber } = SMS_CONFIG.twilio;
      if (!accountSid || !authToken || !fromNumber) {
        logger.warn('Twilio credentials not configured. SMS service disabled.');
        return;
      }
      this.client = twilio(accountSid, authToken);
      this.isInitialized = true;
      logger.info('SMS service initialized successfully with Twilio');
      this.setupMonitoring();
    } catch (error) {
      logger.error('Failed to initialize SMS service:', error);
      this.isInitialized = false;
    }
  }

  // Setup monitoring and cleanup
  setupMonitoring() {
    // Update metrics every hour
    setInterval(async () => {
      await this.updateMetrics();
    }, 60 * 60 * 1000); // 1 hour

    // Report metrics every hour
    setInterval(() => {
      logger.info('SMS metrics:', this.metrics);
      smsEvents.emit('metrics:hourly', { ...this.metrics });
    }, 60 * 60 * 1000); // 1 hour
  }

  // Update metrics
  async updateMetrics() {
    try {
      const pipeline = [
        {
          $match: {
            'status.isActive': true,
            'deletion.isDeleted': false,
            'contact.phone': { $exists: true },
            'contact.phoneVerified': true,
          },
        },
        {
          $group: {
            _id: null,
            usersWithPhone: { $sum: 1 },
          },
        },
      ];
      const result = await NotificationUser.aggregate(pipeline);
      if (result.length > 0) {
        this.metrics.usersWithPhone = result[0].usersWithPhone;
      }
    } catch (error) {
      logger.error('Failed to update SMS metrics:', error);
    }
  }

  // Validate phone number
  validatePhoneNumber(phone) {
    const phoneRegex = /^\+\d{1,3}\d{6,14}$/;
    if (!phone || !phoneRegex.test(phone)) {
      throw new Error('Invalid phone number format. Must be in E.164 format (e.g., +1234567890)');
    }
  }

  // Validate payload
  validatePayload(payload) {
    if (!payload.body) {
      throw new Error('SMS body is required');
    }
    if (payload.body.length > SMS_CONFIG.defaults.maxLength) {
      throw new Error(`SMS body exceeds ${SMS_CONFIG.defaults.maxLength} character limit`);
    }
    if (payload.priority && !['low', 'medium', 'high', 'critical'].includes(payload.priority)) {
      throw new Error('Invalid priority. Must be low, medium, high, or critical');
    }
    if (payload.type && !['general', 'security', 'marketing', 'system', 'urgent'].includes(payload.type)) {
      throw new Error('Invalid notification type');
    }
  }

  // Send SMS to a single user
  async send(userId, payload, options = {}) {
    if (!this.isInitialized) {
      logger.warn('SMS service not initialized');
      return { success: false, error: 'Service not available' };
    }
    try {
      this.validatePayload(payload);
      const user = await NotificationUser.findOne({ userId });
      if (!user) {
        return { success: false, error: 'User not found' };
      }
      if (!user.contact.phone || !user.contact.phoneVerified) {
        return { success: false, error: 'User has no verified phone number' };
      }
      if (!user.canReceiveNotification(payload.type || 'general', 'sms', payload.priority || SMS_CONFIG.defaults.priority)) {
        return { success: false, error: 'User preferences block SMS notifications' };
      }
      const rateLimit = user.checkRateLimit();
      if (!rateLimit.allowed) {
        return { success: false, error: `Rate limit exceeded: ${rateLimit.reason}` };
      }
      const messageOptions = {
        from: SMS_CONFIG.twilio.fromNumber,
        to: user.contact.phone,
        body: payload.body,
        messagingServiceSid: options.messagingServiceSid || undefined,
        statusCallback: options.statusCallback || undefined,
      };
      let attempt = 0;
      let lastError;
      while (attempt < SMS_CONFIG.settings.retryAttempts) {
        try {
          const message = await this.client.messages.create(messageOptions);
          this.metrics.sent++;
          this.metrics.byProvider.twilio++;
          await user.recordNotificationReceived('sms');
          await user.incrementRateLimit();
          user.compliance.auditLog.push({
            action: 'sms_sent',
            timestamp: new Date(),
            details: `Message SID: ${message.sid}, Type: ${payload.type || 'general'}`,
            ipAddress: options.ipAddress,
          });
          await user.save();
          smsEvents.emit('sms:sent', {
            userId,
            messageSid: message.sid,
            phone: user.contact.phone,
            type: payload.type || 'general',
          });
          logger.info('SMS sent successfully', { userId, messageSid: message.sid });
          return {
            success: true,
            messageSid: message.sid,
            phone: user.contact.phone,
          };
        } catch (error) {
          lastError = error;
          attempt++;
          if (this.isPermanentError(error)) {
            break;
          }
          if (attempt < SMS_CONFIG.settings.retryAttempts) {
            await new Promise(resolve => setTimeout(resolve, SMS_CONFIG.settings.retryDelay * attempt));
          }
        }
      }
      this.metrics.failed++;
      user.compliance.auditLog.push({
        action: 'sms_failed',
        timestamp: new Date(),
        details: `Error: ${lastError.message}, Type: ${payload.type || 'general'}`,
        ipAddress: options.ipAddress,
      });
      await user.save();
      smsEvents.emit('sms:failed', {
        userId,
        error: lastError.message,
        phone: user.contact.phone,
      });
      logger.error('Failed to send SMS', { userId, error: lastError.message });
      return {
        success: false,
        error: lastError.message,
        statusCode: lastError.status,
      };
    } catch (error) {
      this.metrics.failed++;
      logger.error('SMS send error:', { userId, error: error.message });
      smsEvents.emit('sms:error', { userId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  // Check if error is permanent (don't retry)
  isPermanentError(error) {
    const permanentStatusCodes = [400, 401, 403, 404, 410];
    return permanentStatusCodes.includes(error.status);
  }

  // Send bulk SMS notifications
  async sendBulk(notificationList, options = {}) {
    const results = [];
    const errors = [];
    for (const notification of notificationList) {
      try {
        const result = await this.send(notification.userId, notification.payload, {
          ...options,
          ipAddress: notification.ipAddress || options.ipAddress,
        });
        if (result.success) {
          results.push({
            userId: notification.userId,
            result,
          });
        } else {
          errors.push({
            userId: notification.userId,
            error: result.error,
          });
        }
      } catch (error) {
        errors.push({
          userId: notification.userId,
          error: error.message,
        });
      }
    }
    smsEvents.emit('sms:bulk_sent', {
      total: notificationList.length,
      sent: results.length,
      failed: errors.length,
    });
    logger.info('Bulk SMS sent', {
      total: notificationList.length,
      sent: results.length,
      failed: errors.length,
    });
    return {
      success: true,
      total: notificationList.length,
      sent: results.length,
      failed: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // Add or update phone number for a user
  async addPhoneNumber(userId, phoneNumber, metadata = {}) {
    if (!this.isInitialized) {
      throw new Error('SMS service not initialized');
    }
    try {
      this.validatePhoneNumber(phoneNumber);
      const user = await NotificationUser.findOne({ userId });
      if (!user) {
        throw new Error('User not found');
      }
      const oldPhone = user.contact.phone;
      user.contact.phone = phoneNumber;
      user.contact.phoneVerified = false; // Require verification
      user.compliance.auditLog.push({
        action: 'phone_added',
        field: 'contact.phone',
        oldValue: oldPhone,
        newValue: phoneNumber,
        timestamp: new Date(),
        ipAddress: metadata.ipAddress,
      });
      await user.save();
      smsEvents.emit('phone:added', { userId, phoneNumber });
      logger.info('Phone number added', { userId, phoneNumber });
      return { success: true, phoneNumber };
    } catch (error) {
      logger.error('Failed to add phone number', { userId, phoneNumber, error: error.message });
      smsEvents.emit('phone:error', { userId, error: error.message });
      throw error;
    }
  }

  // Verify phone number (simplified, assumes external verification process)
  async verifyPhoneNumber(userId, phoneNumber, metadata = {}) {
    try {
      const user = await NotificationUser.findOne({ userId });
      if (!user) {
        throw new Error('User not found');
      }
      if (user.contact.phone !== phoneNumber) {
        throw new Error('Phone number does not match user record');
      }
      user.contact.phoneVerified = true;
      user.contact.phoneVerifiedAt = new Date();
      user.compliance.auditLog.push({
        action: 'phone_verified',
        field: 'contact.phoneVerified',
        newValue: true,
        timestamp: new Date(),
        ipAddress: metadata.ipAddress,
      });
      await user.save();
      smsEvents.emit('phone:verified', { userId, phoneNumber });
      logger.info('Phone number verified', { userId, phoneNumber });
      return { success: true, phoneNumber };
    } catch (error) {
      logger.error('Failed to verify phone number', { userId, phoneNumber, error: error.message });
      smsEvents.emit('phone:error', { userId, error: error.message });
      throw error;
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
        successRate: Math.round(successRate * 100) / 100,
      },
      twilio: {
        configured: !!(SMS_CONFIG.twilio.accountSid && SMS_CONFIG.twilio.authToken),
        fromNumber: SMS_CONFIG.twilio.fromNumber,
      },
      settings: SMS_CONFIG.settings,
      isInitialized: this.isInitialized,
    };
  }

  // Test SMS service
  async testSMSService(userId, testPhoneNumber = null) {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }
    try {
      const testPayload = {
        body: 'This is a test SMS from Throne8',
        type: 'system',
        priority: 'low',
      };
      if (testPhoneNumber) {
        this.validatePhoneNumber(testPhoneNumber);
        const user = await NotificationUser.findOne({ userId });
        if (!user) {
          throw new Error('User not found');
        }
        const originalPhone = user.contact.phone;
        user.contact.phone = testPhoneNumber;
        user.contact.phoneVerified = true; // Temporarily verify for testing
        await user.save();
        const result = await this.send(userId, testPayload);
        user.contact.phone = originalPhone; // Restore original phone
        user.contact.phoneVerified = false; // Reset verification
        await user.save();
        return result;
      } else {
        return await this.send(userId, testPayload);
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Reset metrics
  resetMetrics() {
    this.metrics = {
      sent: 0,
      delivered: 0,
      failed: 0,
      byProvider: {
        twilio: 0,
        other: 0,
      },
    };
  }
}

// Create singleton instance
const smsService = new SMSService();

// Export the service and event emitter
export default smsService;
// export { smsEvents };

// Export individual methods for direct use
export const sendSMS = (userId, payload, options) =>
  smsService.send(userId, payload, options);
export const sendBulkSMS = (notificationList, options) =>
  smsService.sendBulk(notificationList, options);
export const addPhoneNumber = (userId, phoneNumber, metadata) =>
  smsService.addPhoneNumber(userId, phoneNumber, metadata);
export const verifyPhoneNumber = (userId, phoneNumber, metadata) =>
  smsService.verifyPhoneNumber(userId, phoneNumber, metadata);
export const testSMSService = (userId, testPhoneNumber) =>
  smsService.testSMSService(userId, testPhoneNumber);
export const getSMSHealthStatus = () => smsService.getHealthStatus();