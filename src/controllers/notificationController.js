// notificationController.js
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import push from '../services/channels/pushService.js';
import mobile from '../services/channels/mobileService.js';
import notificationService from '../services/core/notificationService.js';

// Send a new notification with enhanced validation and features
export const sendNotification = async (req, res, next) => {
    try {
        const { userId, channels, title, body, type = 'general', data = {}, scheduledFor } = req.body;

        if (!userId || !channels || !title || !body) {
            return res.status(400).json({
                success: false,
                error: 'userId, channels, title, and body are required',
            });
        }

        const notification = await Notification.create({
            userId,
            channels,
            title,
            body,
            type,
            data: {
                ...data,
                source: data.source || 'api',
                timestamp: new Date()
            },
            scheduledFor,
            status: scheduledFor ? 'queued' : 'pending'
        });

        if (!scheduledFor) {
            try {
                await notificationService.send(userId, channels, { title, body, type, data });
                notification.status = 'sent';
                notification.updateDeliveryStatus('push', 'sent', { sentAt: new Date() });

                // Emit notification via Socket.IO
                const io = req.app.get('io');
                io.to(userId).emit('notification', {
                    id: notification._id,
                    userId,
                    title,
                    body,
                    type,
                    channels,
                    createdAt: notification.createdAt
                });
            } catch (error) {
                console.error('Failed to send notification:', error.message);
                notification.status = 'failed';
                notification.updateDeliveryStatus('push', 'failed', { error: error.message });
            }
            await notification.save();
        }

        res.status(201).json({ 
            success: true, 
            notification: {
                id: notification._id,
                userId: notification.userId,
                title: notification.title,
                type: notification.type,
                status: notification.status,
                channels: notification.channels,
                scheduledFor: notification.scheduledFor,
                createdAt: notification.createdAt
            }
        });
    } catch (e) {
        next(e);
    }
};
// Get notifications with advanced filtering and pagination
export const getUserNotifications = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { 
      type, 
      seen, 
      priority,
      limit = 50, 
      skip = 0,
      startDate,
      endDate,
      campaignId,
      unreadOnly = false
    } = req.query;

    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId is required' 
      });
    }

    let query = { userId, isDeleted: false };

    // Apply filters
    if (type) query.type = type;
    if (seen !== undefined) query.seen = seen === 'true';
    if (priority) query.priority = parseInt(priority);
    if (campaignId) query['data.campaignId'] = campaignId;
    
    // Date range filter
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Use optimized static method for unread notifications
    if (unreadOnly === 'true') {
      const notifications = await Notification.findUnreadByUser(
        userId, 
        parseInt(limit), 
        parseInt(skip)
      );
      return res.json({ success: true, notifications, count: notifications.length });
    }

    const notifications = await Notification.find(query)
      .sort({ priority: 1, createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .select('-delivery -__v') // Exclude heavy fields for list view
      .lean();

    const totalCount = await Notification.countDocuments(query);

    res.json({ 
      success: true, 
      notifications, 
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        skip: parseInt(skip),
        hasMore: totalCount > parseInt(skip) + parseInt(limit)
      }
    });
  } catch (e) {
    next(e);
  }
};

// Get single notification with full details
export const getNotificationById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;

    if (!id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Notification id is required' 
      });
    }

    let query = { _id: id, isDeleted: false };
    if (userId) query.userId = userId;

    const notification = await Notification.findOne(query);
    
    if (!notification) {
      return res.status(404).json({ 
        success: false, 
        error: 'Notification not found' 
      });
    }

    res.json({ success: true, notification });
  } catch (e) {
    next(e);
  }
};

// Mark single notification as read using instance method
export const markNotificationRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Notification id is required' 
      });
    }

    let query = { _id: id };
    if (userId) query.userId = userId;

    const notification = await Notification.findOne(query);
    
    if (!notification) {
      return res.status(404).json({ 
        success: false, 
        error: 'Notification not found' 
      });
    }

    await notification.markAsSeen();
    
    res.json({ 
      success: true, 
      notification: {
        id: notification._id,
        seen: notification.seen,
        seenAt: notification.seenAt
      }
    });
  } catch (e) {
    next(e);
  }
};

// Mark notification as clicked
export const markNotificationClicked = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Notification id is required' 
      });
    }

    let query = { _id: id };
    if (userId) query.userId = userId;

    const notification = await Notification.findOne(query);
    
    if (!notification) {
      return res.status(404).json({ 
        success: false, 
        error: 'Notification not found' 
      });
    }

    await notification.markAsClicked();
    
    res.json({ 
      success: true, 
      notification: {
        id: notification._id,
        clicked: notification.clicked,
        clickedAt: notification.clickedAt
      }
    });
  } catch (e) {
    next(e);
  }
};

// Bulk mark notifications as read
export const bulkMarkAsRead = async (req, res, next) => {
  try {
    const { userId, notificationIds } = req.body;

    if (!userId || !notificationIds || !Array.isArray(notificationIds)) {
      return res.status(400).json({
        success: false,
        error: 'userId and notificationIds array are required'
      });
    }

    const result = await Notification.bulkMarkAsSeen(userId, notificationIds);
    
    res.json({ 
      success: true, 
      modifiedCount: result.modifiedCount,
      matchedCount: result.matchedCount
    });
  } catch (e) {
    next(e);
  }
};

// Get notifications by type
export const getNotificationsByType = async (req, res, next) => {
  try {
    const { userId, type } = req.params;
    const { limit = 20 } = req.query;

    if (!userId || !type) {
      return res.status(400).json({
        success: false,
        error: 'userId and type are required'
      });
    }

    const notifications = await Notification.findByUserAndType(
      userId, 
      type, 
      parseInt(limit)
    );

    res.json({ success: true, notifications });
  } catch (e) {
    next(e);
  }
};

// Get user notification analytics
export const getUserAnalytics = async (req, res, next) => {
  try {
    const { userId } = req.params;
    let { startDate, endDate } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    // Default to last 30 days if no dates provided
    if (!startDate) startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (!endDate) endDate = new Date();

    const analytics = await Notification.getAnalytics(
      userId, 
      new Date(startDate), 
      new Date(endDate)
    );

    // Get summary stats
    const summary = await Notification.aggregate([
      {
        $match: {
          userId,
          createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) },
          isDeleted: false
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          unread: { $sum: { $cond: [{ $eq: ['$seen', false] }, 1, 0] } },
          clicked: { $sum: { $cond: ['$clicked', 1, 0] } },
          avgPriority: { $avg: '$priority' }
        }
      }
    ]);

    res.json({ 
      success: true, 
      analytics: {
        byType: analytics,
        summary: summary[0] || { total: 0, unread: 0, clicked: 0, avgPriority: 0 }
      }
    });
  } catch (e) {
    next(e);
  }
};

// Update notification delivery status
export const updateDeliveryStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { channel, status, metadata = {} } = req.body;

    if (!id || !channel || !status) {
      return res.status(400).json({
        success: false,
        error: 'id, channel, and status are required'
      });
    }

    const notification = await Notification.findById(id);
    
    if (!notification) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }

    notification.updateDeliveryStatus(channel, status, metadata);
    
    // Update overall status based on delivery results
    if (status === 'delivered' || status === 'sent') {
      notification.status = 'sent';
    } else if (status === 'failed' && notification.retryCount < notification.maxRetries) {
      notification.status = 'failed';
      notification.incrementRetry();
    }

    await notification.save();

    res.json({ 
      success: true, 
      delivery: notification.delivery[channel],
      overallStatus: notification.status
    });
  } catch (e) {
    next(e);
  }
};

// Soft delete notification
export const deleteNotification = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Notification id is required'
      });
    }

    let query = { _id: id };
    if (userId) query.userId = userId;

    const notification = await Notification.findOne(query);
    
    if (!notification) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }

    await notification.softDelete();
    
    res.json({ success: true, message: 'Notification deleted successfully' });
  } catch (e) {
    next(e);
  }
};

// Get scheduled notifications (admin endpoint)
export const getScheduledNotifications = async (req, res, next) => {
  try {
    const { limit = 100, skip = 0 } = req.query;

    const notifications = await Notification.find({
      status: 'queued',
      scheduledFor: { $exists: true, $gt: new Date() },
      isDeleted: false
    })
    .sort({ scheduledFor: 1 })
    .limit(parseInt(limit))
    .skip(parseInt(skip))
    .select('userId title type scheduledFor priority data.campaignId')
    .lean();

    res.json({ success: true, notifications });
  } catch (e) {
    next(e);
  }
};

// Get failed notifications for retry processing (admin endpoint)
export const getFailedNotifications = async (req, res, next) => {
  try {
    const { limit = 50 } = req.query;

    const notifications = await Notification.findForRetry(parseInt(limit));

    res.json({ success: true, notifications });
  } catch (e) {
    next(e);
  }
};

// Subscribe web push (enhanced)
export const subscribePush = async (req, res, next) => {
  try {
    const { userId, subscription } = req.body;
    
    if (!userId || !subscription) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId and subscription are required' 
      });
    }

    const user = await push.addSubscription(userId, subscription);
    
    res.json({ success: true, userId: user.userId });
  } catch (e) {
    next(e);
  }
};

// Register mobile token (enhanced)
export const registerMobile = async (req, res, next) => {
  try {
    const { userId, platform, token } = req.body;
    
    if (!userId || !platform || !token) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId, platform, and token are required' 
      });
    }

    // Validate platform
    if (!['ios', 'android'].includes(platform)) {
      return res.status(400).json({
        success: false,
        error: 'Platform must be either ios or android'
      });
    }

    await mobile.registerToken(userId, platform, token);
    
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
};

// Set or update user email (enhanced)
export const setUserEmail = async (req, res, next) => {
  try {
    const { userId, email } = req.body;
    
    if (!userId || !email) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId and email are required' 
      });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    const user = await User.findOneAndUpdate(
      { userId },
      { userId, email, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, user });
  } catch (e) {
    next(e);
  }
};

// Health check endpoint for notification system
export const healthCheck = async (req, res, next) => {
  try {
    const stats = await Notification.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const pendingCount = await Notification.countDocuments({
      status: { $in: ['pending', 'queued'] },
      isDeleted: false
    });

    const failedCount = await Notification.countDocuments({
      status: 'failed',
      retryCount: { $lt: 3 },
      isDeleted: false
    });

    res.json({
      success: true,
      health: {
        status: 'healthy',
        timestamp: new Date(),
        stats: stats.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        pending: pendingCount,
        needingRetry: failedCount
      }
    });
  } catch (e) {
    next(e);
  }
};