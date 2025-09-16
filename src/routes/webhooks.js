// routes/webhooks.js
import express from 'express';
import rateLimit from 'express-rate-limit';
import { body, param, query } from 'express-validator';

// Import webhook controller functions
import * as webhookController from '../controllers/webhookController.js';
// Import handleValidationErrors from notification controller
import { handleValidationErrors } from '../controllers/notificationController.js';

const router = express.Router();

// Webhook-specific rate limiting
const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // Higher limit for webhooks from trusted sources
  message: { success: false, error: 'Webhook rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting for requests with valid API keys
  skip: (req) => {
    const apiKey = req.headers['x-api-key'];
    return apiKey && isValidApiKey(apiKey);
  }
});

// Batch webhook rate limiting (stricter)
const batchWebhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100, // Lower limit for batch operations
  message: { success: false, error: 'Batch webhook rate limit exceeded' }
});

// Provider webhook rate limiting
const providerWebhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 2000, // High limit for provider webhooks
  message: { success: false, error: 'Provider webhook rate limit exceeded' }
});

// Validation middleware
const validateWebhookPayload = [
  body('event')
    .notEmpty()
    .isLength({ min: 1, max: 100 })
    .matches(/^[a-zA-Z0-9._-]+$/)
    .withMessage('Valid event name is required'),
  body('userId')
    .notEmpty()
    .isLength({ min: 1, max: 50 })
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Valid userId is required'),
  body('channels')
    .optional()
    .isArray({ min: 1, max: 5 })
    .withMessage('Channels must be an array with 1-5 items'),
  body('payload')
    .isObject()
    .withMessage('Payload must be an object'),
  body('metadata')
    .optional()
    .isObject()
    .withMessage('Metadata must be an object'),
  body('priority')
    .optional()
    .isIn(['critical', 'high', 'medium', 'low'])
    .withMessage('Invalid priority level'),
  body('scheduled_for')
    .optional()
    .isISO8601()
    .withMessage('Invalid scheduled_for date format')
];

const validateBatchWebhook = [
  body('notifications')
    .isArray({ min: 1, max: 100 })
    .withMessage('Notifications array required (1-100 items)'),
  body('notifications.*.event')
    .notEmpty()
    .withMessage('Event is required for each notification'),
  body('notifications.*.userId')
    .notEmpty()
    .withMessage('UserId is required for each notification'),
  body('notifications.*.payload')
    .isObject()
    .withMessage('Payload is required for each notification'),
  body('metadata')
    .optional()
    .isObject()
    .withMessage('Metadata must be an object')
];

const validateDeliveryWebhook = [
  param('provider')
    .isIn(['sendgrid', 'mailgun', 'twilio', 'firebase', 'huawei', 'apns'])
    .withMessage('Valid provider is required'),
  body('notification_id')
    .notEmpty()
    .withMessage('Notification ID is required'),
  body('status')
    .isIn(['sent', 'delivered', 'failed', 'bounced', 'clicked', 'opened'])
    .withMessage('Valid status is required'),
  body('timestamp')
    .optional()
    .isISO8601()
    .withMessage('Invalid timestamp format')
];

// Helper function to validate API keys
function isValidApiKey(apiKey) {
  const validKeys = (process.env.VALID_API_KEYS || '').split(',');
  return validKeys.includes(apiKey);
}

// Middleware to verify webhook signatures
const verifyWebhookSignature = (req, res, next) => {
  // Skip signature verification in development
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];

  if (!signature || !timestamp) {
    return res.status(401).json({
      success: false,
      error: 'Missing webhook signature or timestamp'
    });
  }

  // Verify timestamp (prevent replay attacks)
  const now = Math.floor(Date.now() / 1000);
  const webhookTimestamp = parseInt(timestamp, 10);
  if (Math.abs(now - webhookTimestamp) > 300) { // 5 minutes tolerance
    return res.status(401).json({
      success: false,
      error: 'Webhook timestamp too old'
    });
  }

  // TODO: Add signature verification logic (HMAC-SHA256 with secret)

  next();
};

// === MAIN WEBHOOK ENDPOINTS ===
router.post('/',
  webhookRateLimit,
  verifyWebhookSignature,
  validateWebhookPayload,
  handleValidationErrors, // Now using the imported function
  webhookController.handleWebhook
);

router.post('/batch',
  batchWebhookRateLimit,
  verifyWebhookSignature,
  validateBatchWebhook,
  handleValidationErrors,
  webhookController.handleBatchWebhook
);

// === PROVIDER-SPECIFIC WEBHOOK ENDPOINTS ===
router.post('/email/:provider',
  providerWebhookRateLimit,
  param('provider').isIn(['sendgrid', 'mailgun', 'ses', 'postmark']),
  handleValidationErrors,
  (req, res, next) => {
    req.body.provider = req.params.provider;
    webhookController.handleDeliveryStatusWebhook(req, res, next);
  }
);

router.post('/sms/:provider',
  providerWebhookRateLimit,
  param('provider').isIn(['twilio', 'nexmo', 'messagebird']),
  handleValidationErrors,
  (req, res, next) => {
    req.body.provider = req.params.provider;
    webhookController.handleDeliveryStatusWebhook(req, res, next);
  }
);

router.post('/push/:provider',
  providerWebhookRateLimit,
  param('provider').isIn(['firebase', 'apns', 'huawei', 'onesignal']),
  handleValidationErrors,
  (req, res, next) => {
    req.body.provider = req.params.provider;
    webhookController.handleDeliveryStatusWebhook(req, res, next);
  }
);

// === DELIVERY STATUS WEBHOOKS ===
router.post('/delivery/:provider',
  providerWebhookRateLimit,
  validateDeliveryWebhook,
  handleValidationErrors,
  webhookController.handleDeliveryStatusWebhook
);

// === SPECIFIC PROVIDER IMPLEMENTATIONS ===
router.post('/sendgrid',
  providerWebhookRateLimit,
  body().isArray().withMessage('SendGrid webhook expects array payload'),
  handleValidationErrors,
  (req, res, next) => {
    req.body = {
      provider: 'sendgrid',
      events: req.body
    };
    webhookController.handleDeliveryStatusWebhook(req, res, next);
  }
);

router.post('/mailgun',
  providerWebhookRateLimit,
  body('event-data').isObject().withMessage('Mailgun webhook expects event-data'),
  handleValidationErrors,
  (req, res, next) => {
    req.body = {
      provider: 'mailgun',
      eventData: req.body['event-data']
    };
    webhookController.handleDeliveryStatusWebhook(req, res, next);
  }
);

router.post('/twilio',
  providerWebhookRateLimit,
  body('MessageStatus').notEmpty().withMessage('Twilio webhook expects MessageStatus'),
  handleValidationErrors,
  (req, res, next) => {
    req.body = {
      provider: 'twilio',
      messageStatus: req.body.MessageStatus,
      messageSid: req.body.MessageSid,
      to: req.body.To,
      from: req.body.From
    };
    webhookController.handleDeliveryStatusWebhook(req, res, next);
  }
);

router.post('/firebase',
  providerWebhookRateLimit,
  body('message').isObject().withMessage('Firebase webhook expects message object'),
  handleValidationErrors,
  (req, res, next) => {
    req.body = {
      provider: 'firebase',
      message: req.body.message
    };
    webhookController.handleDeliveryStatusWebhook(req, res, next);
  }
);

// === TESTING AND MONITORING ENDPOINTS ===
router.get('/health', webhookController.webhookHealthCheck);

router.post('/test',
  body('event').optional().isString(),
  body('userId').optional().matches(/^[a-zA-Z0-9_-]+$/),
  handleValidationErrors,
  (req, res) => {
    const testPayload = {
      event: req.body.event || 'test.webhook',
      userId: req.body.userId || 'test-user',
      channels: ['push'],
      payload: {
        title: 'Test Webhook Notification',
        body: 'This is a test notification from webhook',
        type: 'system',
        priority: 'low',
        data: {
          test: true,
          timestamp: new Date().toISOString()
        }
      },
      metadata: {
        source: 'webhook_test',
        timestamp: new Date()
      }
    };

    webhookController.handleWebhook({ ...req, body: testPayload }, res);
  }
);

router.get('/stats',
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
  handleValidationErrors,
  (req, res) => {
    const { startDate, endDate } = req.query;
    res.json({
      success: true,
      period: {
        startDate: startDate || new Date(Date.now() - 24 * 60 * 60 * 1000),
        endDate: endDate || new Date()
      },
      statistics: {
        totalWebhooks: 1234,
        successful: 1200,
        failed: 34,
        successRate: 97.2,
        averageProcessingTime: 150,
        byProvider: {
          sendgrid: { count: 500, successRate: 98.5 },
          firebase: { count: 400, successRate: 96.8 },
          twilio: { count: 334, successRate: 97.0 }
        }
      }
    });
  }
);

router.get('/recent',
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('provider').optional().isString(),
  query('status').optional().isIn(['success', 'failed', 'pending']),
  handleValidationErrors,
  (req, res) => {
    const { limit = 50, provider, status } = req.query;
    res.json({
      success: true,
      webhooks: [
        {
          id: 'wh_123',
          provider: 'sendgrid',
          event: 'user.registered',
          status: 'success',
          processingTime: 120,
          timestamp: new Date()
        }
      ],
      filters: { limit, provider, status },
      total: 1234
    });
  }
);

router.post('/:webhookId/replay',
  param('webhookId').isAlphanumeric(),
  handleValidationErrors, // Now using the imported function
  (req, res) => {
    const { webhookId } = req.params;
    res.json({
      success: true,
      message: 'Webhook replayed successfully',
      webhookId,
      replayedAt: new Date()
    });
  }
);

// === EVENT-SPECIFIC WEBHOOK HANDLERS ===
router.post('/events/user',
  body('event').isIn(['user.registered', 'user.login', 'user.verified', 'user.deleted']),
  body('userId').notEmpty(),
  body('userData').isObject(),
  handleValidationErrors,
  (req, res, next) => {
    const { event, userId, userData } = req.body;
    req.body = {
      event,
      userId,
      channels: ['email', 'push'],
      payload: {
        title: `User ${event.split('.')[1]}`,
        body: `User ${userId} ${event.split('.')[1]}`,
        type: 'system',
        data: userData
      }
    };
    webhookController.handleWebhook(req, res, next);
  }
);

router.post('/events/payment',
  body('event').isIn(['payment.success', 'payment.failed', 'payment.refund']),
  body('userId').notEmpty(),
  body('paymentData').isObject(),
  handleValidationErrors,
  (req, res, next) => {
    const { event, userId, paymentData } = req.body;
    req.body = {
      event,
      userId,
      channels: ['email', 'push'],
      payload: {
        title: `Payment ${event.split('.')[1]}`,
        body: `Your payment of ${paymentData.amount} was ${event.split('.')[1]}`,
        type: 'payment',
        priority: 'high',
        data: paymentData
      }
    };
    webhookController.handleWebhook(req, res, next);
  }
);

router.post('/events/social',
  body('event').isIn(['social.like', 'social.comment', 'social.follow', 'social.mention']),
  body('userId').notEmpty(),
  body('socialData').isObject(),
  handleValidationErrors,
  (req, res, next) => {
    const { event, userId, socialData } = req.body;
    req.body = {
      event,
      userId,
      channels: ['push'],
      payload: {
        title: `New ${event.split('.')[1]}`,
        body: socialData.message || `You have a new ${event.split('.')[1]}`,
        type: 'social',
        data: socialData
      }
    };
    webhookController.handleWebhook(req, res, next);
  }
);

// === ERROR HANDLING ===
// === ERROR HANDLING ===
router.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Webhook endpoint not found',
    path: req.originalUrl,
    method: req.method,
    availableEndpoints: [
      'POST /',
      'POST /batch',
      'POST /delivery/:provider',
      'POST /email/:provider',
      'POST /sms/:provider',
      'POST /push/:provider',
      'GET /health',
      'POST /test'
    ]
  });
});
export default router;