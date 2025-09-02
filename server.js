import 'dotenv/config';
import app from './src/app.js';
import mongoose from 'mongoose';

async function start() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB connected');
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`🚀 Notification service listening on ${port}`));
}
start().catch(err => { console.error(err); process.exit(1); });
