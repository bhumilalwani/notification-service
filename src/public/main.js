// client.js - Production-Grade Frontend Client
class Throne8NotificationClient {
  constructor(config = {}) {
    this.config = {
      apiUrl: config.apiUrl || 'http://localhost:5000',
      socketUrl: config.socketUrl || 'http://localhost:5000',
      vapidPublicKey: config.vapidPublicKey || 'BLbT2SiI_H5p27ZactxMW1sFLsyrSZPNve50FF8SGWOkU7o1ykIIL8VnYgLivCqArdBLKTOwcuze8gT36CbGwIk',
      debug: config.debug || false,
      retryAttempts: config.retryAttempts || 3,
      retryDelay: config.retryDelay || 1000
    };
    
    this.socket = null;
    this.isConnected = false;
    this.userId = null;
    this.subscription = null;
    this.serviceWorkerReg = null;
    this.eventHandlers = new Map();
    
    this.init();
  }

    urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
 async requestNotificationPermission() {
    if (!("Notification" in window)) {
      throw new Error("This browser does not support notifications");
    }

    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }

    return permission;
  }
  // Initialize the client
  async init() {
    try {
      await this.initServiceWorker();
      this.initSocketIO();
      this.setupEventListeners();
      this.log('Throne8 Notification Client initialized');
    } catch (error) {
      this.log('Initialization failed:', error);
    }
  }

  // Initialize Service Worker
  async initServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service Worker not supported');
    }

    try {
      this.serviceWorkerReg = await navigator.serviceWorker.register('/sw.js', {
        scope: '/'
      });
      
      this.log('Service Worker registered successfully');
      
      // Wait for service worker to be ready
      await navigator.serviceWorker.ready;
      
    } catch (error) {
      this.log('Service Worker registration failed:', error);
      throw error;
    }
  }

  // Initialize Socket.IO connection
  initSocketIO() {
    this.socket = io(this.config.socketUrl, {
      transports: ['websocket', 'polling'],
      timeout: 20000,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });

    this.socket.on('connect', () => {
      this.isConnected = true;
      this.log('Connected to WebSocket server');
      this.emit('connected');
    });

    this.socket.on('disconnect', (reason) => {
      this.isConnected = false;
      this.log('Disconnected from WebSocket:', reason);
      this.emit('disconnected', reason);
    });

    this.socket.on('notification', (data) => {
      this.handleRealtimeNotification(data);
    });

    this.socket.on('registered', (data) => {
      this.log('Successfully registered with server:', data);
      this.emit('registered', data);
    });

    this.socket.on('error', (error) => {
      this.log('Socket error:', error);
      this.emit('error', error);
    });

    this.socket.on('notification_marked_read', (data) => {
      this.emit('notification_read', data);
    });

    this.socket.on('notification_count', (data) => {
      this.emit('notification_count', data);
    });
  }

  // Setup browser event listeners
  setupEventListeners() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.userId) {
        this.getNotificationCount();
      }
    });

    window.addEventListener('online', () => {
      this.log('Browser back online');
      if (!this.isConnected && this.userId) {
        this.registerUser(this.userId);
      }
    });

    window.addEventListener('offline', () => {
      this.log('Browser went offline');
    });
  }

  // Register user
  async registerUser(userId, options = {}) {
    if (!userId) throw new Error('User ID is required');
    this.userId = userId;

    if (this.socket && this.isConnected) {
      this.socket.emit('register', {
        userId,
        token: options.token,
        timestamp: new Date().toISOString()
      });
    }

    this.log(`Registered user: ${userId}`);
    console.log("registered user: ", userId);
    return true;
  }

  // Subscribe to push notifications
 // Subscribe to push notifications
async subscribeToPush(userId, options = {}) {
  try {
    if (!userId) throw new Error('User ID is required');
    console.log('subscribeToPush: Starting push subscription for user:', userId);

    if (!('Notification' in window)) throw new Error('Notifications not supported');
    console.log('subscribeToPush: Notification API is supported');

    console.log('subscribeToPush: Requesting notification permission...');
    const permission = await this.requestNotificationPermission();
    console.log('subscribeToPush: Notification permission status:', permission);
    if (permission !== 'granted') throw new Error('Notification permission denied');

    console.log('subscribeToPush: Converting VAPID public key...');
    const applicationServerKey = await this.urlBase64ToUint8Array(this.config.vapidPublicKey);
    console.log('subscribeToPush: VAPID public key converted:', applicationServerKey);

    console.log('subscribeToPush: Subscribing to push manager...');
    this.subscription = await this.serviceWorkerReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
    console.log('subscribeToPush: Push manager subscription:', this.subscription.toJSON());

    const payload = {
      userId,
      subscription: this.subscription.toJSON(),
      metadata: {
        userAgent: navigator.userAgent,
        url: window.location.href,
        timestamp: new Date().toISOString(),
        ...options.metadata
      }
    };
    console.log('subscribeToPush: Push subscription payload:', JSON.stringify(payload, null, 2));

    console.log('subscribeToPush: Sending API call to /api/v1/notifications/push/subscribe...');
    const response = await this.apiCall('/api/v1/notifications/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    console.log('subscribeToPush: API response:', response);

    if (!response.success) throw new Error(response.error || 'Subscription failed');

    console.log('subscribeToPush: Push subscription successful');
    this.emit('push_subscribed', { userId, subscription: this.subscription });
    return this.subscription;

  } catch (error) {
    console.log('subscribeToPush: Push subscription failed:', error.message, error.stack);
    this.emit('push_subscription_failed', error);
    throw error;
  }
}

  // Mark notification as read
  async markNotificationRead(notificationId) {
    try {
      if (this.socket && this.isConnected) {
        this.socket.emit('mark_notification_read', { notificationId });
      }

      const response = await this.apiCall(`/api/v1/notifications/${notificationId}/read`, {
        method: 'PUT',
        body: JSON.stringify({ userId: this.userId, source: 'client' })
      });

      return response;
    } catch (error) {
      this.log('Failed to mark notification as read:', error);
      throw error;
    }
  }

  // Add this inside Throne8NotificationClient class
log(...args) {
  if (this.config.debug) {
    console.log('[Throne8Client]', ...args);
  }
}

on(event, handler) {
  if (!this.eventHandlers.has(event)) {
    this.eventHandlers.set(event, []);
  }
  this.eventHandlers.get(event).push(handler);
}

emit(event, data) {
  if (this.eventHandlers.has(event)) {
    for (const handler of this.eventHandlers.get(event)) {
      handler(data);
    }
  }
}


  // Get user notifications
  async getNotifications(options = {}) {
    try {
      const params = new URLSearchParams({
        limit: options.limit || 50,
        skip: options.skip || 0,
        ...(options.type && { type: options.type }),
        ...(options.unreadOnly && { unreadOnly: options.unreadOnly })
      });

      const response = await this.apiCall(`/api/v1/notifications/${this.userId}?${params}`);
      return response;
    } catch (error) {
      this.log('Failed to get notifications:', error);
      throw error;
    }
  }

  // API call helper
 async apiCall(endpoint, options = {}) {
  const url = `${this.config.apiUrl}${endpoint}`;
  const defaultOptions = {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  };
  let lastError;
  for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
    try {
      console.log(`apiCall: Making request to ${url}, attempt ${attempt}/${this.config.retryAttempts}`);
      const response = await fetch(url, { ...defaultOptions, ...options });
      if (!response.ok) {
        const errorBody = await response.text();
        console.log(`apiCall: Error response (attempt ${attempt}):`, errorBody);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const jsonResponse = await response.json();
      console.log(`apiCall: Successful response:`, jsonResponse);
      return jsonResponse;
    } catch (error) {
      lastError = error;
      console.log(`apiCall: Attempt ${attempt}/${this.config.retryAttempts} failed:`, error.message);
      if (attempt < this.config.retryAttempts) {
        await new Promise(res => setTimeout(res, this.config.retryDelay * attempt));
      }
    }
  }
  console.log('apiCall: All attempts failed, throwing last error:', lastError);
  throw lastError;
}
}

// Legacy globals
const VAPID_PUBLIC_KEY = 'BLbT2SiI_H5p27ZactxMW1sFLsyrSZPNve50FF8SGWOkU7o1ykIIL8VnYgLivCqArdBLKTOwcuze8gT36CbGwIk';
const throne8Client = new Throne8NotificationClient({ debug: true, vapidPublicKey: VAPID_PUBLIC_KEY });

async function subscribeToPushNotifications() {
  try {
    const userId = document.getElementById("uid")?.value;
    if (!userId) return alert("Please enter a User ID");

    await throne8Client.registerUser(userId);
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
