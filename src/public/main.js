const VAPID_PUBLIC_KEY = 'BLbT2SiI_H5p27ZactxMW1sFLsyrSZPNve50FF8SGWOkU7o1ykIIL8VnYgLivCqArdBLKTOwcuze8gT36CbGwIk';

async function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

document.getElementById('sub').onclick = async () => {
  const userId = document.getElementById('uid').value;
  if (!('serviceWorker' in navigator)) return alert('No service worker support');
  const reg = await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return alert('Notifications blocked');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: await urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });
  await fetch('/notifications/subscribe', {
    method:'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ userId, subscription: sub })
  });
  alert('Subscribed! Now POST to /notifications to test.');
};
