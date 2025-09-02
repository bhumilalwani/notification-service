import webPush from 'web-push';
import User from '../../models/User.js';

webPush.setVapidDetails(
  process.env.VAPID_CONTACT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function addSubscription(userId, subscription) {
  let user = await User.findOne({ userId });
  if (!user) user = await User.create({ userId, pushSubscriptions: [] });
  const exists = (user.pushSubscriptions || []).some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    user.pushSubscriptions.push(subscription);
    await user.save();
  }
  return user;
}

async function send(user, payload) {
  if (!user?.pushSubscriptions?.length) return;
  const body = JSON.stringify({ title: payload.title, body: payload.body, data: payload.data || {} });
  await Promise.allSettled(user.pushSubscriptions.map(sub => webPush.sendNotification(sub, body).catch(e=>{ console.error('push err', e.message); })));
}

export default { addSubscription, send };
