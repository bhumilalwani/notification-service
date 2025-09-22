// debug-firebase.js - Simple version
import dotenv from 'dotenv';
dotenv.config();

console.log('Starting Firebase Debug...');

console.log('\nEnvironment Variables:');
console.log('PROJECT_ID:', process.env.FIREBASE_PROJECT_ID || 'Missing');
console.log('CLIENT_EMAIL:', process.env.FIREBASE_CLIENT_EMAIL || 'Missing');
console.log('PRIVATE_KEY:', process.env.FIREBASE_PRIVATE_KEY ? 'Present' : 'Missing');

try {
  console.log('\nTrying to import firebase-admin...');
  const admin = await import('firebase-admin');
  console.log('Firebase admin imported successfully');
  
  console.log('\nTrying to initialize...');
  const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
  
  admin.default.initializeApp({
    credential: admin.default.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
  
  console.log('Firebase initialized successfully!');
  
} catch (error) {
  console.log('\nError occurred:');
  console.log('Message:', error.message);
  console.log('Code:', error.code);
}