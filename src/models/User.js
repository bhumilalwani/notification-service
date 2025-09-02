import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const UserSchema = new Schema({
  userId: { type: String, unique: true },
  email: String,
  pushSubscriptions: [Schema.Types.Mixed] // store web push subs
});
export default model('User', UserSchema);
