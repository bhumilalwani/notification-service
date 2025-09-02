import notificationService from '../services/core/notificationService.js';
import push from '../services/channels/pushService.js';
import mobile from '../services/channels/mobileService.js';
import User from '../models/User.js';

export const sendNotification = async (req, res, next) => {
  try {
    const { userId, channels, payload } = req.body;
    const result = await notificationService.send(userId, channels, payload);
    res.json({ success: true, notification: result });
  } catch (e) { next(e); }
};

export const getUserNotifications = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const list = await notificationService.list(userId);
    res.json({ success: true, notifications: list });
  } catch (e) { next(e); }
};

export const markNotificationRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    const n = await notificationService.markRead(id);
    res.json({ success: true, notification: n });
  } catch (e) { next(e); }
};

// Subscribe web push
export const subscribePush = async (req, res, next) => {
  try {
    const { userId, subscription } = req.body;
    const user = await push.addSubscription(userId, subscription);
    res.json({ success: true, userId: user.userId });
  } catch (e) { next(e); }
};

// Register mobile token
export const registerMobile = async (req, res, next) => {
  try {
    const { userId, platform, token } = req.body;
    await mobile.registerToken(userId, platform, token);
    res.json({ success: true });
  } catch (e) { next(e); }
};

// Set user email
export const setUserEmail = async (req, res, next) => {
  try {
    const { userId, email } = req.body;
    const user = await User.findOneAndUpdate(
      { userId },
      { userId, email },
      { upsert: true, new: true }
    );
    res.json({ success: true, user });
  } catch (e) { next(e); }
};
