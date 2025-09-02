import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const NotificationSchema = new Schema({
  userId: { type: String, index: true },
  title: String,
  body: String,
  type: { type: String, default: 'general' },
  channels: [String],
  data: Schema.Types.Mixed,
  seen: { type: Boolean, default: false }
}, { timestamps: true });
export default model('Notification', NotificationSchema);
