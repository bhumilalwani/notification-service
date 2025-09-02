import DeviceToken from '../../models/DeviceToken.js';
import path from 'path';
import adminLib from 'firebase-admin';

let admin;
function ensureFirebase() {
  if (admin) return admin;
  const saPath = process.env.FIREBASE_SA_PATH;
  if (!saPath) throw new Error('FIREBASE_SA_PATH not set');
  const serviceAccount = require(path.resolve(saPath));
  admin = adminLib.initializeApp({ credential: adminLib.credential.cert(serviceAccount) });
  return admin;
}

async function registerToken(userId, platform, token) {
  await DeviceToken.findOneAndUpdate({ userId, platform, token }, { userId, platform, token }, { upsert: true });
}

async function send(user, payload) {
  const admin = ensureFirebase();
  const tokens = await DeviceToken.find({ userId: user.userId });
  if (!tokens.length) return;
  const message = { notification: { title: payload.title, body: payload.body }, android: { priority: 'high' }, apns: { headers: { 'apns-priority': '10' } } };
  await Promise.allSettled(tokens.map(t => admin.messaging().send({ ...message, token: t.token }).catch(e=>console.error('fcm send err', e.message))));
}

export default { registerToken, send };

