import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import hpp from 'hpp';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import { authRouter } from './routes/auth.js';
import { companyProfileRouter } from './routes/companyProfile.js';
import { jobsRouter } from './routes/jobs.js';
import { companiesRouter } from './routes/companies.js';
import { adminRouter } from './routes/admin.js';
import { connectionsRouter } from './routes/connections.js';
import { feedRouter } from './routes/feed.js';
import { jobSeekerProfileRouter } from './routes/jobSeekerProfile.js';
import { leavesRouter } from './routes/leaves.js';
import { notificationsRouter } from './routes/notifications.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const maxBody = '512kb';
const isProd = process.env.NODE_ENV === 'production';
const maxRequests = Number.parseInt(process.env.RATE_LIMIT_MAX || '300', 10);
const windowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(15 * 60_000), 10);

function parseOrigins() {
  const raw = process.env.CORS_ORIGIN;
  if (!raw || raw === '*') return true;
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  const corsOrigins = parseOrigins();
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
    })
  );
  app.use(
    helmet({
      contentSecurityPolicy: isProd,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use(
    rateLimit({
      windowMs,
      max: isProd ? maxRequests : 2000,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Too many requests, please try again later' },
    })
  );
  const authLimit = rateLimit({
    windowMs: 15 * 60_000,
    max: isProd ? 50 : 200,
    message: { message: 'Too many sign-in attempts, please try again later' },
  });
  app.use(hpp());
  app.use(mongoSanitize());
  if (!isProd) {
    app.use(morgan('dev'));
  } else {
    app.use(
      morgan('combined', {
        skip: (_req, res) => res.statusCode < 400,
      })
    );
  }
  app.use(
    express.json({ limit: maxBody, strict: true }),
    express.urlencoded({ extended: true, limit: maxBody })
  );
  app.use(compression());
  // Static path reserved for future admin assets
  const publicDir = path.join(__dirname, '../public');
  app.use(
    express.static(publicDir, {
      maxAge: isProd ? '1d' : 0,
    })
  );
  // Company verification uploads (PDFs, etc)
  const uploadsDir = path.join(__dirname, '../uploads');
  app.use('/uploads', express.static(uploadsDir, { maxAge: isProd ? '1d' : 0 }));
  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'ok', uptime: process.uptime() });
  });
  app.use('/api/auth', authLimit, authRouter);
  app.use('/api/company-profile', companyProfileRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api/job-seeker-profile', jobSeekerProfileRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/connections', connectionsRouter);
  app.use('/api/feed', feedRouter);
  app.use('/api/leaves', leavesRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/admin', adminRouter);
  app.use((_req, res) => {
    return res.status(404).json({ message: 'Not found' });
  });
  app.use((err, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error(err);
    return res.status(500).json({ message: isProd ? 'Internal server error' : err.message });
  });
  return app;
}
