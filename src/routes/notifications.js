import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { param, query, body } from 'express-validator';
import validator from 'validator';
import * as notificationController from '../controllers/notificationController.js';

const router = express.Router();

// Rate limiting for notification endpoints
const notificationRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 500, // limit each IP to 500 requests per minute
  message: { success: false, error: 'Too many notification requests' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator, // Use ipKeyGenerator for proper IP handling
});

// === STATIC ROUTES FIRST (no parameters) ===

// Health check
router.get('/health', ...notificationController.healthCheck);

// Get notification templates
router.get('/templates', notificationRateLimit, ...notificationController.getNotificationTemplates);

// Get scheduled notifications
router.get('/scheduled', notificationRateLimit, ...notificationController.getScheduledNotifications);

// Get failed notifications
router.get('/failed', notificationRateLimit, ...notificationController.getFailedNotifications);

// Cleanup expired tokens (admin endpoint)
router.post('/cleanup/tokens', notificationRateLimit, ...notificationController.cleanupExpiredTokens);

// Bulk operations
router.patch('/bulk/read', notificationRateLimit, ...notificationController.bulkMarkAsRead);
router.delete('/bulk/delete', notificationRateLimit, ...notificationController.bulkDeleteNotifications);

// Push subscription
router.post('/push/subscribe', notificationRateLimit, ...notificationController.subscribePush);

// Mobile device registration
router.post('/mobile/register', notificationRateLimit, ...notificationController.registerMobile);

// Device token management
router.patch('/device/deactivate', notificationRateLimit, ...notificationController.deactivateDeviceToken);
router.patch('/device/refresh', notificationRateLimit, ...notificationController.refreshDeviceToken);
router.post('/device/validate', notificationRateLimit, ...notificationController.validateDeviceToken);

// User preference and consent management
router.patch('/preferences', notificationRateLimit, ...notificationController.updateUserPreferences);
router.post('/email', notificationRateLimit, ...notificationController.setUserEmail);
router.post('/consent/grant', notificationRateLimit, ...notificationController.grantConsent);
router.post('/consent/revoke', notificationRateLimit, ...notificationController.revokeConsent);

// Pause/resume notifications
router.post('/pause', notificationRateLimit, ...notificationController.pauseUserNotifications);
router.post('/resume', notificationRateLimit, ...notificationController.resumeUserNotifications);

// === USER-SPECIFIC ROUTES ===

// Get notifications for a user
router.get('/user/:userId', notificationRateLimit, ...notificationController.getUserNotifications);

// Get notifications by type
router.get('/user/:userId/type/:type', notificationRateLimit, ...notificationController.getNotificationsByType);

// Get grouped notifications
router.get('/user/:userId/group/:groupId', notificationRateLimit, ...notificationController.getGroupedNotifications);

// Get user analytics
router.get('/user/:userId/analytics', notificationRateLimit, ...notificationController.getUserAnalytics);

// Search notifications
router.get('/user/:userId/search', notificationRateLimit, ...notificationController.searchNotifications);

// Get device token analytics
router.get('/user/:userId/device/analytics', notificationRateLimit, ...notificationController.getDeviceTokenAnalytics);

// === NOTIFICATION ID ROUTES (most specific patterns last) ===

// Create notification (POST to root)
router.post('/', notificationRateLimit, ...notificationController.sendNotification);




// Add these new routes to your existing routes file
router.post('/fcm/register', notificationRateLimit, ...notificationController.registerFCMToken);
router.post('/test', notificationRateLimit, ...notificationController.testPushNotification);
router.get('/firebase/health', notificationRateLimit,   notificationController.firebaseHealth);


// Retry notification
router.post('/:id/retry', 
  notificationRateLimit,
  param('id').custom(value => {
    if (!validator.isMongoId(value)) {
      throw new Error('Invalid notification ID');
    }
    return true;
  }),
  notificationController.handleValidationErrors,
  ...notificationController.retryNotification
);

// Update delivery status (for webhooks)
router.patch('/:id/delivery', 
  notificationRateLimit,
  param('id').custom(value => {
    if (!validator.isMongoId(value)) {
      throw new Error('Invalid notification ID');
    }
    return true;
  }),
  notificationController.handleValidationErrors,
  ...notificationController.updateDeliveryStatus
);

// Mark notification as read
router.patch('/:id/read',
  notificationRateLimit,
  param('id').custom(value => {
    if (!validator.isMongoId(value)) {
      throw new Error('Invalid notification ID');
    }
    return true;
  }),
  notificationController.handleValidationErrors,
  ...notificationController.markNotificationRead
);

// Mark notification as clicked
router.patch('/:id/clicked',
  notificationRateLimit,
  param('id').custom(value => {
    if (!validator.isMongoId(value)) {
      throw new Error('Invalid notification ID');
    }
    return true;
  }),
  notificationController.handleValidationErrors,
  ...notificationController.markNotificationClicked
);

// Dismiss notification
router.patch('/:id/dismiss',
  notificationRateLimit,
  param('id').custom(value => {
    if (!validator.isMongoId(value)) {
      throw new Error('Invalid notification ID');
    }
    return true;
  }),
  notificationController.handleValidationErrors,
  ...notificationController.dismissNotification
);

// Get single notification by ID
router.get('/:id',
  notificationRateLimit,
  param('id').custom(value => {
    if (!validator.isMongoId(value)) {
      throw new Error('Invalid notification ID');
    }
    return true;
  }),
  notificationController.handleValidationErrors,
  ...notificationController.getNotificationById
);

// Delete notification
router.delete('/:id',
  notificationRateLimit,
  param('id').custom(value => {
    if (!validator.isMongoId(value)) {
      throw new Error('Invalid notification ID');
    }
    return true;
  }),
  notificationController.handleValidationErrors,
  ...notificationController.deleteNotification
);

// 404 handler for notifications
router.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Notification endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

export default router;