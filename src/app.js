import express from 'express';
import path from 'path';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';

import notifRoutes from './routes/notifications.js';
import webhookRoutes from './routes/webhooks.js';
import bodyParser from 'body-parser';
import { errorHandler } from './middleware/errorHandler.js';

import { fileURLToPath } from 'url';

const app = express();

// Middlewares
app.use(express.json());
app.use(bodyParser.json());
app.use(cors());

app.use(morgan('dev'));
app.use(helmet());


// emulate __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Serve static files from /src/public
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/notifications', notifRoutes);
app.use('/webhook', webhookRoutes);

// Serve index.html for root
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// Error handler
app.use(errorHandler);

export default app;
