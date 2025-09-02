import express from 'express';
import * as c from '../controllers/notificationController.js';

const router = express.Router();

router.post('/', c.sendNotification);
router.get('/:userId', c.getUserNotifications);
router.put('/:id/read', c.markNotificationRead);
router.post('/subscribe', c.subscribePush);
router.post('/mobile/register', c.registerMobile);
router.post('/user/email', c.setUserEmail);

export default router;
