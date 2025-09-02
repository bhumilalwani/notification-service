import notificationService from '../services/core/notificationService.js';

// Other services post here to trigger notifications
export const handleWebhook = async (req, res, next) => {
  try {
    const { event, userId, channels = ['push'], payload } = req.body;
    // You can enrich payload or map event->channels here
    await notificationService.send(userId, channels, payload);
    res.json({ success: true });
  } catch (e) { 
    next(e); 
  }
};
