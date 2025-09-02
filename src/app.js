import express from 'express';
import path from 'path';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';

import notifRoutes from './routes/notifications.js';
import webhookRoutes from './routes/webhooks.js';
import { errorHandler } from './middleware/errorHandler.js';

// static demo client & service worker

import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(helmet());


// emulate __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


app.use('/notifications', notifRoutes);
app.use('/webhook', webhookRoutes);

app.get('/', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));
app.use(errorHandler);

export default app;
