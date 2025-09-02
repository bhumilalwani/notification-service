self.addEventListener('push', event => {
  try {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'Notification';
    const options = { body: data.body || '', data: data.data || {} };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) { console.error(e); }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
