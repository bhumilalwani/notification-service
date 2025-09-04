import Notification from '../../models/Notification.js';
import User from '../../models/User.js';
import email from '../channels/emailService.js';
import push from '../channels/pushService.js';
import mobile from '../channels/mobileService.js';

class NotificationService {
  init(io, connectedUsers) {
    this.io = io;
    this.connectedUsers = connectedUsers;
  }

  async send(userId, channels = ['push'], payload = {}) {
    const doc = await Notification.create({
      userId,
      title: payload.title,
      body: payload.body,
      type: payload.type || 'general',
      channels,
      data: payload.data || {}
    });

    let delivered = false;

    try {
      const user = await User.findOne({ userId });
      
      // Handle real-time socket notification (separate from push)
      const socketId = this.connectedUsers?.get(userId);
      console.log(`Checking socket for user ${userId}: ${socketId}`);
      
      if (socketId && this.io) {
        try {
          await this.io.to(socketId).emit('notification', {
            title: payload.title,
            body: payload.body,
            data: payload.data || {},
            timestamp: new Date()
          });
          console.log(`Socket notification sent to ${socketId}`);
          
          // Update delivery status for socket (you might want a 'socket' channel type)
          doc.updateDeliveryStatus('socket', 'sent');
          delivered = true;
        } catch (socketError) {
          console.error('Socket emission failed:', socketError);
          doc.updateDeliveryStatus('socket', 'failed');
        }
      } else {
        console.log(`User ${userId} not connected via socket`);
      }

      // Handle different notification channels
      if (channels.includes('email')) {
        try {
          await email.send(user, payload);
          doc.updateDeliveryStatus('email', 'sent');
          delivered = true;
        } catch (emailError) {
          console.error('Email notification failed:', emailError);
          doc.updateDeliveryStatus('email', 'failed');
        }
      }

      if (channels.includes('push')) {
        try {
          await push.send(user, payload);
          doc.updateDeliveryStatus('push', 'sent');
          delivered = true;
        } catch (pushError) {
          console.error('Push notification failed:', pushError);
          doc.updateDeliveryStatus('push', 'failed');
        }
      }

      if (channels.includes('mobile')) {
        try {
          await mobile.send(user, payload);
          doc.updateDeliveryStatus('mobile', 'sent');
          delivered = true;
        } catch (mobileError) {
          console.error('Mobile notification failed:', mobileError);
          doc.updateDeliveryStatus('mobile', 'failed');
        }
      }

      // Update overall status
      doc.status = delivered ? 'sent' : 'failed';
      await doc.save();
      
      if (delivered) {
        await doc.markSent();
      } else {
        await doc.markFailed();
      }

    } catch (err) {
      console.error('Notification service error:', err);
      doc.status = 'failed';
      await doc.save();
      await doc.markFailed();
      throw err;
    }

    return doc;
  }

  async list(userId) {
    return Notification.find({ userId }).sort({ createdAt: -1 });
  }

  async markRead(id) {
    return Notification.findByIdAndUpdate(id, { seen: true }, { new: true });
  }
}

export default new NotificationService();