// src/services/firebase/firebaseAdmin.js
import admin from 'firebase-admin';

class FirebaseAdminService {
  constructor() {
    this.isInitialized = false;
    this.messaging = null;
    this.init();
  
  }
  init() {
    try {
      console.log('🔥 Initializing Firebase Admin...');
      
      // Check if already initialized
      if (admin.apps.length > 0) {
        console.log('✅ Firebase already initialized');
        this.messaging = admin.messaging();
        this.isInitialized = true;
        return;
      }

      // Validate environment variables
      if (!process.env.FIREBASE_PROJECT_ID) {
        throw new Error('FIREBASE_PROJECT_ID not found in environment variables');
      }
      if (!process.env.FIREBASE_CLIENT_EMAIL) {
        throw new Error('FIREBASE_CLIENT_EMAIL not found in environment variables');
      }
      if (!process.env.FIREBASE_PRIVATE_KEY) {
        throw new Error('FIREBASE_PRIVATE_KEY not found in environment variables');
      }

      console.log('📋 Environment variables found:');
      console.log('- Project ID:', process.env.FIREBASE_PROJECT_ID);
      console.log('- Client Email:', process.env.FIREBASE_CLIENT_EMAIL);
      console.log('- Private Key:', process.env.FIREBASE_PRIVATE_KEY ? 'Present' : 'Missing');

      // Create service account object
      const serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      };

      // Initialize Firebase Admin
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID,
      });

      this.messaging = admin.messaging();
      this.isInitialized = true;
      
      console.log('✅ Firebase Admin initialized successfully');
      
    } catch (error) {
      console.error('❌ Failed to initialize Firebase Admin:', error.message);
      console.error('Stack:', error.stack);
      this.isInitialized = false;
    }
  }

  // Send notification to a single device token
  async sendToDevice(token, notification, data = {}) {
    if (!this.isInitialized) {
      throw new Error('Firebase Admin not initialized');
    }

    try {
      console.log('📤 Sending FCM notification to token:', token.substring(0, 20) + '...');

      const message = {
        token,
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: {
          ...data,
          timestamp: Date.now().toString(),
        },
        android: {
          notification: {
            sound: 'default',
            priority: 'high',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      const response = await this.messaging.send(message);
      console.log('✅ FCM message sent successfully:', response);
      
      return {
        success: true,
        messageId: response,
      };

    } catch (error) {
      console.error('❌ FCM send error:', error.message);
      
      // Handle token errors
      if (error.code === 'messaging/registration-token-not-registered' || 
          error.code === 'messaging/invalid-registration-token') {
        return {
          success: false,
          error: 'Invalid or unregistered token',
          shouldRemoveToken: true,
        };
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  // Test if Firebase is working
  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, error: 'Not initialized' };
    }

    try {
      // Try to send a message with dry_run to test connection
      const testMessage = {
        token: 'test-token-that-will-fail', // This will fail, but proves Firebase works
        notification: {
          title: 'Test',
          body: 'Test',
        },
      };

      await this.messaging.send(testMessage, true); // dry_run = true
      console.log("helllooooooo from firebaseAdmin file line 145🩷🩷🩷");
      return { success: true, message: 'Firebase connection working🐦‍🔥' };
      
    } catch (error) {
      // If error is about invalid token, that's actually good - means Firebase is working
      if (error.code === 'messaging/invalid-registration-token') {
        return { success: true, message: 'Firebase connection working (expected token error)' };
      }
      
      return { success: false, error: error.message };
    }
  }

  // Get health status
  getHealth() {
    return {
      initialized: this.isInitialized,
      projectId: process.env.FIREBASE_PROJECT_ID,
      hasMessaging: !!this.messaging,
    };
  }
}

// Create singleton instance
const firebaseAdminService = new FirebaseAdminService();

export default firebaseAdminService;