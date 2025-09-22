// client.js - Production-Grade Frontend Client
// main.js - Your original structure with fixes
class Throne8Client {
  constructor(config = {}) {
    this.config = {
      apiBase: config.apiBase || 'http://localhost:5000',
      userId: config.userId || null,
      vapidPublicKey: config.vapidPublicKey || null,
      ...config
    };
    
    this.ws = null;
    this.notifications = []; // Add this if you use it
    this.isSubscribed = false;
    
    console.log('[Throne8Client] Throne8 Notification Client initialized');
    this.init();
  }
  
  init() {
    // Your original init code
    console.log('[Throne8Client] Initializing...');
    
    // Check if socket.io is available
    if (typeof io === 'undefined') {
      console.error('[Throne8Client] Socket.IO not loaded. Add <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script> to HTML');
      return;
    }
    
    this.connectWebSocket();
  }
  
  connectWebSocket() {
    // Your original WebSocket connection code
    const socket = io(this.config.apiBase); // Use your original approach
    
    socket.on('connect', () => {
      console.log('[Throne8Client] Connected to WebSocket server');
      this.ws = socket;
      
      // Register user if you have one
      if (this.config.userId) {
        this.registerUser(this.config.userId);
      }
    });
    
    socket.on('disconnect', () => {
      console.log('[Throne8Client] Disconnected from WebSocket');
    });
    
    // Your original event handlers
    socket.on('notification', (data) => {
      console.log('Received notification:', data);
      this.handleIncomingNotification(data);
    });
  }
  
  registerUser(userId) {
    // Your original registration code
    if (this.ws) {
      this.ws.emit('register', { userId });
      console.log('Registered user:', userId);
    }
  }
  
  // 🔥 ADD THIS MISSING METHOD
  getNotificationCount() {
    console.log('[Throne8Client] Getting notification count');
    
    // Option 1: If you maintain a notifications array
    if (this.notifications && Array.isArray(this.notifications)) {
      return this.notifications.filter(n => !n.seen).length; // Unread count
    }
    
    // Option 2: If you store in localStorage
    try {
      const stored = localStorage.getItem('throne8-notifications');
      if (stored) {
        const notifications = JSON.parse(stored);
        return notifications ? notifications.filter(n => !n.seen).length : 0;
      }
    } catch (error) {
      console.warn('[Throne8Client] Error parsing stored notifications:', error);
    }
    
    // Option 3: API call to get count
    return this.fetchNotificationCount();
  }
  
  // Helper method for API-based count
  async fetchNotificationCount() {
    try {
      const response = await fetch(`${this.config.apiBase}/api/v1/notifications/count`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const data = await response.json();
      return data.unreadCount || 0;
    } catch (error) {
      console.error('[Throne8Client] Failed to fetch notification count:', error);
      return 0;
    }
  }
  
  // Your original push subscription method
  async subscribeToPushNotifications() {
    try {
      console.log('subscribeToPush: Starting for user:', this.config.userId);
      
      if (!('Notification' in window)) {
        throw new Error('Notifications not supported');
      }
      
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Permission denied');
      }
      
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToUint8Array(this.config.vapidPublicKey)
      });
      const token = await messaging.getToken({ vapidKey: 'BGNHjlY31Q1NxybqYF5AKKHkzsoT6wIi_tla6MDo9o42XBPm7SdArGXbDu5zjV3O3X1CwfrqMvUkfbc66j309G8' });
        console.log('Push subscription obtained:', subscription);
      const payload = {
        userId: this.config.userId,
        fcmToken:token,
        subscription: subscription.toJSON(),
        metadata: {
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString()
        }
      };
      
      const response = await fetch(`${this.config.apiBase}/api/v1/notifications/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const result = await response.json();
      
      if (result.success) {
        this.isSubscribed = true;
        console.log('✅ Push subscription successful');
        return result;
      } else {
        throw new Error(result.error || 'Subscription failed');
      }
      
    } catch (error) {
      console.error('❌ Push subscription failed:', error);
      throw error;
    }
  }
  
  // Your original notification handler
  handleIncomingNotification(data) {
    console.log('Handling notification:', data);
    
    // Add to local notifications array
    if (this.notifications) {
      this.notifications.unshift({
        ...data,
        seen: false,
        receivedAt: new Date()
      });
      
      // Keep only last 50 notifications
      if (this.notifications.length > 50) {
        this.notifications = this.notifications.slice(0, 50);
      }
      
      // Save to localStorage
      try {
        localStorage.setItem('throne8-notifications', JSON.stringify(this.notifications));
      } catch (error) {
        console.warn('Failed to save notifications to localStorage:', error);
      }
    }
    
    // Show browser notification
    if (Notification.permission === 'granted') {
      const notification = new Notification(data.title, {
        body: data.body,
        icon: data.icon || '/favicon.ico'
      });
      
      notification.onclick = () => {
        window.focus();
        notification.close();
        this.markNotificationSeen(data.id);
      };
    }
  }
  
  markNotificationSeen(id) {
    // Mark as seen in local array
    if (this.notifications) {
      const notification = this.notifications.find(n => n.id === id);
      if (notification) {
        notification.seen = true;
        notification.seenAt = new Date();
        this.saveNotifications();
      }
    }
    
    // Send to server
    if (this.ws) {
      this.ws.emit('notification_seen', { id, userId: this.config.userId });
    }
  }
  
  saveNotifications() {
    try {
      localStorage.setItem('throne8-notifications', JSON.stringify(this.notifications));
    } catch (error) {
      console.warn('Failed to save notifications:', error);
    }
  }
  
  // Your original VAPID utility
  urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
  
  // Add any other missing methods your original code had
  async loadNotifications() {
    try {
      const response = await fetch(`${this.config.apiBase}/api/v1/notifications`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const data = await response.json();
      if (data.success) {
        this.notifications = data.notifications || [];
        this.saveNotifications();
        return this.notifications;
      }
    } catch (error) {
      console.error('Failed to load notifications:', error);
    }
    return [];
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, creating Throne8Client...');
  
  const client = new Throne8Client({
    userId: 'u123',
    vapidPublicKey: 'BGNHjlY31Q1NxybqYF5AKKHkzsoT6wIi_tla6MDo9o42XBPm7SdArGXbDu5zjV3O3X1CwfrqMvUkfbc66j309G8', // Replace with your key
    apiBase: 'http://localhost:5000'
  });
  
  // Make globally available
  window.throne8Client = client;
  
  // Fix the line 130 error - add event listener properly
  setTimeout(() => {
    // This is likely where line 130 is - wrap it properly
    if (client.getNotificationCount) {
      console.log('Unread notifications:', client.getNotificationCount());
      
      // Update UI if you have notification badge
      const badge = document.getElementById('notification-badge');
      if (badge) {
        badge.textContent = client.getNotificationCount();
        badge.style.display = client.getNotificationCount() > 0 ? 'inline' : 'none';
      }
    }
  }, 1000);
  
  // Your original subscription button handler
  const subscribeBtn = document.getElementById('subscribe-btn');
  if (subscribeBtn) {
    subscribeBtn.addEventListener('click', async () => {
      try {
        subscribeBtn.disabled = true;
        subscribeBtn.textContent = 'Subscribing...';
        
        await client.subscribeToPushNotifications();
        
        subscribeBtn.textContent = 'Subscribed ✓';
        subscribeBtn.disabled = true;
        
      } catch (error) {
        console.error('Subscription failed:', error);
        subscribeBtn.textContent = 'Try Again';
        subscribeBtn.disabled = false;
      }
    });
  }
  
  // Auto-subscribe after registration (if you have this)
  if (client.ws) {
    client.ws.on('registered', () => {
      console.log('User registered, auto-subscribing...');
      setTimeout(() => client.subscribeToPushNotifications().catch(console.error), 1000);
    });
  }
});

// Legacy globals
const VAPID_PUBLIC_KEY = 'BGNHjlY31Q1NxybqYF5AKKHkzsoT6wIi_tla6MDo9o42XBPm7SdArGXbDu5zjV3O3X1CwfrqMvUkfbc66j309G8';
const throne8Client = new Throne8NotificationClient({ debug: true, vapidPublicKey: VAPID_PUBLIC_KEY });

async function subscribeToPushNotifications() {
  try {
    const userId = document.getElementById("uid")?.value;
    if (!userId) return alert("Please enter a User ID");

    await throne8Client.registerUser(userId);
    console.log("registered user: 😪😪😪", userId);
    await throne8Client.subscribeToPush(userId); // fixed function name

    log("✅ Successfully subscribed to push notifications");
  } catch (error) {
    log(`❌ Subscription failed: ${error.message}`);
    alert(`Subscription failed: ${error.message}`);
  }
}

function log(msg) {
  console.log(msg);
  const logDiv = document.getElementById("log");
  if (logDiv) {
    const p = document.createElement("p");
    p.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg);
    logDiv.appendChild(p);
    logDiv.scrollTop = logDiv.scrollHeight;
  }
}

throne8Client.on('connected', () => log("✅ Connected to WebSocket server"));
throne8Client.on('notification_received', (data) => log(`🔔 Notification: ${data.title} - ${data.body}`));
throne8Client.on('notification_count', (data) => log(`📊 Unread notifications: ${data.count}`));

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById("sub")?.addEventListener("click", subscribeToPushNotifications);
  document.getElementById("test")?.addEventListener("click", async () => {
    try {
      await throne8Client.sendTestNotification({
        title: 'Test Notification',
        body: 'This is a test notification from the client'
      });
      log("✅ Test notification sent");
    } catch (error) {
      log(`❌ Test failed: ${error.message}`);
    }
  });
});
