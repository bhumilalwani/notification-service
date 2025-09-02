import express from 'express';
import { handleWebhook } from '../controllers/webhookController.js';

const router = express.Router();

router.post('/', handleWebhook);
export default router;
