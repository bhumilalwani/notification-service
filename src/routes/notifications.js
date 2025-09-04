// routes/notification.js
import express from 'express';
import * as c from '../controllers/notificationController.js';

const router = express.Router();

// Core notification endpoints
router.post('/', c.sendNotification); // Send new notification
router.get('/:userId', c.getUserNotifications); // List notifications for user
router.get('/id/:id', c.getNotificationById); // Get single notification by ID
router.put('/:id/read', c.markNotificationRead); // Mark as read
router.patch('/:id/click', c.markNotificationClicked); // Mark as clicked
router.patch('/bulk/read', c.bulkMarkAsRead); // Bulk mark as read
router.get('/user/:userId/type/:type', c.getNotificationsByType); // Get by type
router.get('/analytics/:userId', c.getUserAnalytics); // Analytics

// Delivery and deletion
router.patch('/:id/delivery', c.updateDeliveryStatus); // Update delivery status
router.delete('/:id', c.deleteNotification); // Soft delete

// Scheduling and retry
router.get('/scheduled/list', c.getScheduledNotifications); // Scheduled notifications
router.get('/failed/list', c.getFailedNotifications); // Failed notifications for retry

// Subscriptions
router.post('/subscribe', c.subscribePush); // Web push subscription
router.post('/mobile/register', c.registerMobile); // Mobile token registration
router.post('/user/email', c.setUserEmail); // Set or update email

// Health check
router.get('/health', c.healthCheck); // Notification system health

export default router;
