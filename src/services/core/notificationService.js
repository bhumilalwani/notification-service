import Notification from '../../models/Notification.js';
import User from '../../models/User.js';
import email from '../channels/emailService.js';
import push from '../channels/pushService.js';
import mobile from '../channels/mobileService.js';

class NotificationService {
  async send(userId, channels = ['push'], payload = {}) {
    const doc = await Notification.create({ userId, title: payload.title, body: payload.body, type: payload.type || 'general', channels, data: payload.data || {} });
    const user = await User.findOne({ userId });
    if (channels.includes('email')) await email.send(user, payload);
    if (channels.includes('push')) await push.send(user, payload);
    if (channels.includes('mobile')) await mobile.send(user, payload);
    return doc;
  }
  async list(userId) { return Notification.find({ userId }).sort({ createdAt: -1 }); }
  async markRead(id) { return Notification.findByIdAndUpdate(id, { seen: true }, { new: true }); }
}
export default new NotificationService();
