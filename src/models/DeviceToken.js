import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const DeviceTokenSchema = new Schema({
  userId: { type: String, index: true },
  platform: { type: String, enum: ['ios','android'], required: true },
  token: { type: String, required: true }
}, { timestamps: true });
export default model('DeviceToken', DeviceTokenSchema);
