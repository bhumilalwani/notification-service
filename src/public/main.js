const VAPID_PUBLIC_KEY = 'BLbT2SiI_H5p27ZactxMW1sFLsyrSZPNve50FF8SGWOkU7o1ykIIL8VnYgLivCqArdBLKTOwcuze8gT36CbGwIk';

async function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// -------------------- SOCKET.IO --------------------
// io is now global (from index.html <script src="/socket.io/socket.io.js">)
const socket = io("http://localhost:5000");

// Log connection
socket.on("connect", () => {
  log("✅ Connected to WebSocket server");
});

// Register user with socket
function registerUser(userId) {
  socket.emit("register", userId);
  log(`📡 Registered with WebSocket as userId: ${userId}`);
}

// Listen for WebSocket notifications
socket.on("notification", (data) => {
  log(`🔔 WS Notification: ${data.message || data.title}`);

  // show native notification if tab is active
  if (Notification.permission === "granted") {
    new Notification(data.title || "New Message", { body: data.body || data.message });
  }
});

// -------------------- PUSH SUBSCRIPTION --------------------
document.getElementById("sub").onclick = async () => {
  const userId = document.getElementById("uid").value;

  // Register to socket.io too
  registerUser(userId);

  if (!("serviceWorker" in navigator)) {
    alert("❌ Service Worker not supported in this browser");
    return;
  }

  // Register service worker
  const reg = await navigator.serviceWorker.register("/sw.js");

  // Ask for notification permission
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    alert("⚠️ Notifications blocked by user");
    return;
  }

  // Subscribe for push notifications
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: await urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });

  // Send subscription to backend
  await fetch("/notifications/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, subscription: sub })
  });

  log("✅ Push subscription saved. You can now test POST /notifications");
};

// -------------------- HELPER --------------------
function log(msg) {
  const logDiv = document.getElementById("log");
  const p = document.createElement("p");
  p.textContent = msg;
  logDiv.appendChild(p);
}
