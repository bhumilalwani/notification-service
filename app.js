let messaging;
let currentToken = null;

function showStatus(message, type = 'info') {
    const statusDiv = document.getElementById('status');
    statusDiv.innerHTML = `<div class="result ${type}">${message}</div>`;
    console.log(`[${type.toUpperCase()}] ${message}`);
}

function initFirebase() {
    console.log('🚀 Initializing Firebase...');
    
    const apiKey = document.getElementById('apiKey').value.trim();
    const projectId = document.getElementById('projectId').value.trim();
    const senderId = document.getElementById('senderId').value.trim();
    const appId = document.getElementById('appId').value.trim();
    const vapidKey = document.getElementById('vapidKey').value.trim();

    if (!vapidKey) {
        showStatus('❌ VAPID Key required! Firebase Console se generate karo.', 'error');
        return;
    }

    try {
        if (typeof firebase === 'undefined') {
            showStatus('❌ Firebase SDK not loaded. Check firebase files.', 'error');
            return;
        }

        showStatus('🔄 Setting up Firebase...', 'warning');

        const firebaseConfig = {
            apiKey: apiKey,
            authDomain: `${projectId}.firebaseapp.com`,
            projectId: projectId,
            storageBucket: `${projectId}.firebasestorage.app`,
            messagingSenderId: senderId,
            appId: appId
        };

        if (firebase.apps.length > 0) {
            messaging = firebase.messaging();
        } else {
            firebase.initializeApp(firebaseConfig);
            messaging = firebase.messaging();
        }

        showStatus('✅ Firebase initialized successfully!', 'success');
        document.getElementById('tokenBtn').disabled = false;
        window.vapidKey = vapidKey;

    } catch (error) {
        console.error('❌ Firebase setup error:', error);
        showStatus(`❌ Firebase setup failed: ${error.message}`, 'error');
    }
}

async function getDeviceToken() {
    console.log('📱 Getting device token...');
    
    if (!messaging || !window.vapidKey) {
        showStatus('❌ Firebase not initialized properly.', 'error');
        return;
    }

    try {
        showStatus('🔄 Requesting notification permission...', 'warning');

        const permission = await Notification.requestPermission();
        
        if (permission !== 'granted') {
            showStatus('❌ Notification permission denied!', 'error');
            return;
        }

        showStatus('🔄 Generating device token...', 'warning');

        const token = await messaging.getToken({
            vapidKey: window.vapidKey
        });

        if (token) {
            currentToken = token;
            showStatus('✅ Device token generated successfully!', 'success');
            
            document.getElementById('tokenResult').innerHTML = `
                <h3>📱 Your Device Token:</h3>
                <div class="result">${token}</div>
                <button onclick="copyToken()">📋 Copy Token</button>
            `;
            
            document.getElementById('testBtn').disabled = false;
            console.log('Device Token:', token);

        } else {
            throw new Error('No token received');
        }

    } catch (error) {
        console.error('❌ Token generation error:', error);
        showStatus(`❌ Token generation failed: ${error.message}`, 'error');
    }
}

function copyToken() {
    if (currentToken) {
        navigator.clipboard.writeText(currentToken).then(() => {
            showStatus('📋 Token copied to clipboard!', 'success');
        }).catch(() => {
            showStatus('📋 Select and copy manually', 'warning');
        });
    }
}

async function testNotification() {
    if (!currentToken) {
        showStatus('❌ No token available', 'error');
        return;
    }

    try {
        new Notification('🎉 Test Notification', {
            body: 'Device token working perfectly! 🚀'
        });
        showStatus('✅ Test notification sent!', 'success');
    } catch (error) {
        showStatus(`❌ Test failed: ${error.message}`, 'error');
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('initBtn').addEventListener('click', initFirebase);
    document.getElementById('tokenBtn').addEventListener('click', getDeviceToken);
    document.getElementById('testBtn').addEventListener('click', testNotification);
    
    setTimeout(() => {
        if (typeof firebase !== 'undefined') {
            showStatus('🔥 Firebase SDK loaded successfully!', 'success');
        } else {
            showStatus('❌ Firebase SDK failed to load!', 'error');
        }
    }, 1000);
});