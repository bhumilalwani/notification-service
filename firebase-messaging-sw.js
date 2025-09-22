// Firebase Service Worker for background notifications
importScripts('./firebase-app-compat.js');
importScripts('./firebase-messaging-compat.js');

// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDLY_KkixQPWyiUY935Nd1MNDNOsAvwMso",
    authDomain: "throne8-notifications.firebaseapp.com",
    projectId: "throne8-notifications",
    storageBucket: "throne8-notifications.firebasestorage.app",
    messagingSenderId: "300084629290",
    appId: "1:300084629290:web:f105c38f9bb6faf9715853"
};

// Initialize Firebase in service worker
firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage(function(payload) {
    console.log('[Service Worker] Background message received:', payload);
    
    const notificationTitle = payload.notification?.title || 'New Notification';
    const notificationOptions = {
        body: payload.notification?.body || 'You have a new message',
        icon: payload.notification?.icon || '/favicon.ico',
        badge: '/favicon.ico',
        tag: payload.data?.tag || 'general',
        data: payload.data || {},
        requireInteraction: payload.data?.requireInteraction === 'true',
        actions: []
    };

    if (payload.data?.actions) {
        try {
            const actions = JSON.parse(payload.data.actions);
            notificationOptions.actions = actions;
        } catch (e) {
            console.log('Failed to parse notification actions');
        }
    }

    return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification clicks
self.addEventListener('notificationclick', function(event) {
    console.log('[Service Worker] Notification clicked:', event.notification);
    
    event.notification.close();
    
    if (event.action) {
        console.log('[Service Worker] Action clicked:', event.action);
        
        event.waitUntil(
            self.clients.matchAll().then(function(clients) {
                clients.forEach(function(client) {
                    client.postMessage({
                        type: 'NOTIFICATION_ACTION',
                        action: event.action,
                        data: event.notification.data
                    });
                });
            })
        );
    } else {
        event.waitUntil(
            self.clients.matchAll({type: 'window'}).then(function(clients) {
                for (let client of clients) {
                    if (client.url.includes(self.location.origin) && 'focus' in client) {
                        return client.focus();
                    }
                }
                
                if (self.clients.openWindow) {
                    return self.clients.openWindow('/');
                }
            })
        );
    }
});

self.addEventListener('install', function(event) {
    console.log('[Service Worker] Installing...');
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    console.log('[Service Worker] Activating...');
    event.waitUntil(self.clients.claim());
});