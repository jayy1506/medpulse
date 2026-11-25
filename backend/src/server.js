import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { connectDB } from './config/db.js';
import { initFirebaseAdmin } from './config/firebase.js';
import { logger, reqLogger, initSentryHook } from './config/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const candidateDistPaths = [
  path.resolve(__dirname, '../../frontend/dist'),
  path.resolve(__dirname, '../client_dist'),
  path.resolve(process.cwd(), 'frontend/dist'),
  path.resolve(process.cwd(), 'backend/client_dist'),
  path.resolve(process.cwd(), 'client_dist'),
  path.resolve(process.cwd(), '../frontend/dist'),
  path.resolve(__dirname, '../frontend/dist')
];
const frontendDistPath = candidateDistPaths.find(p => fs.existsSync(path.join(p, 'index.html')))
  || candidateDistPaths.find(p => fs.existsSync(p))
  || candidateDistPaths[0];

const candidatePublicPaths = [
  path.resolve(__dirname, '../../frontend/public'),
  path.resolve(process.cwd(), 'frontend/public'),
  path.resolve(process.cwd(), 'backend/../frontend/public'),
  path.resolve(process.cwd(), '../frontend/public'),
  path.resolve(__dirname, '../frontend/public')
];
const frontendPublicPath = candidatePublicPaths.find(p => fs.existsSync(p));
const swaggerDocPath = path.resolve(__dirname, './docs/swagger.json');

// ================= Production Safety Validations =================
if (process.env.NODE_ENV === 'production') {
  if (process.env.ALLOW_DEV_AUTH === 'true' || process.env.MOCK_AUTH === 'true') {
    logger.fatal('[FATAL CONFIGURATION ERROR] Mock/Dev authentication mode is strictly forbidden when NODE_ENV=production. Server startup aborted.');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    if (process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
      logger.warn('[SECURITY WARNING] JWT_SECRET not configured in Render environment. Using runtime session fallback secret. Set JWT_SECRET in Render Environment for persistent auth.');
      process.env.JWT_SECRET = 'medpulse_default_render_session_secret_2026_clinical_jwt';
    } else {
      logger.fatal('[FATAL CONFIGURATION ERROR] JWT_SECRET must be configured in production. Server startup aborted.');
      process.exit(1);
    }
  }
  const effectiveClientUrl = process.env.CLIENT_URL || process.env.RENDER_EXTERNAL_URL;
  if (!effectiveClientUrl && !process.env.RENDER && !fs.existsSync(frontendDistPath)) {
    logger.fatal('[FATAL CONFIGURATION ERROR] CLIENT_URL must be configured in production for standalone backend deployment. Server startup aborted.');
    process.exit(1);
  } else if (!effectiveClientUrl) {
    logger.info('[DEPLOYMENT] CLIENT_URL not set; defaulting to unified same-origin frontend serving for Render deployment.');
  }
}

let swaggerDocument = {};
if (fs.existsSync(swaggerDocPath)) {
  swaggerDocument = JSON.parse(fs.readFileSync(swaggerDocPath, 'utf8'));
}

import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import courseRoutes from './routes/courseRoutes.js';
import assessmentRoutes from './routes/assessmentRoutes.js';
import progressRoutes from './routes/progressRoutes.js';
import ragRoutes from './routes/ragRoutes.js';
import aiMemoryRoutes from './routes/aiMemoryRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import conversationRoutes from './routes/conversationRoutes.js';
import documentRoutes from './routes/documentRoutes.js';
import novaRoutes from './routes/novaRoutes.js';
import healthRoutes from './routes/healthRoutes.js';
import { preloadMemoryCache } from './services/semanticMemoryService.js';

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize Optional Sentry Hook
initSentryHook(app);

// Connect to MongoDB
connectDB().then((connected) => {
  if (connected) {
    preloadMemoryCache();
  }
});

// Initialize Firebase Admin SDK
initFirebaseAdmin();

// Structured HTTP Request Logging (Pino)
app.use(reqLogger);

// Enhanced Security Headers via Helmet
app.use(helmet({
  contentSecurityPolicy: false, // Preserves embedded SVGs, canvas, and Vite assets
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginEmbedderPolicy: false,
  xContentTypeOptions: true,
  xFrameOptions: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// CORS Configuration supporting configured client URL, Render deployment URL, and local dev
const allowedOrigins = [
  process.env.CLIENT_URL,
  process.env.RENDER_EXTERNAL_URL,
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5000', 'http://127.0.0.1:5000'] : [])
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // 1. Allow same-origin / server-to-server / curl / mobile / no-origin
    if (!origin) {
      return callback(null, true);
    }
    // 2. Allow explicitly configured origins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // 3. Allow any onrender.com origin (Render unified or split deployments)
    if (origin.endsWith('.onrender.com') || (process.env.RENDER_EXTERNAL_URL && origin === process.env.RENDER_EXTERNAL_URL)) {
      return callback(null, true);
    }
    // 4. In non-production, allow localhost and 127.0.0.1
    if (process.env.NODE_ENV !== 'production' && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: Origin ${origin} not permitted.`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

// Lightweight Health Check Probes (Mounted before rate limiting for Render & monitors)
app.use(healthRoutes);
app.use('/api', healthRoutes);

// Global Express Rate Limit for all API endpoints
const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests from this IP address. Please try again after 15 minutes.'
  }
});
app.use('/api/', globalApiLimiter);

// Interactive OpenAPI / Swagger Documentation
if (swaggerDocument && Object.keys(swaggerDocument).length > 0) {
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  logger.info(`[Swagger Docs] Available at http://127.0.0.1:${PORT}/api/docs`);
}

// Mount API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/assessments', assessmentRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/rag', ragRoutes);
app.use('/api/ai', aiMemoryRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/nova', novaRoutes);

// Serve public assets (images, icons, svgs) directly from frontend/public to save build memory
if (frontendPublicPath) {
  app.use(express.static(frontendPublicPath, { maxAge: '7d' }));
}

// Root API Info Route
app.get('/api', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'MedPulse Medical & Nursing LMS Backend API is running.',
    developer: 'Developed by Jay',
    frontendUrl: process.env.CLIENT_URL || 'https://medpulse-h24h.onrender.com',
    health: '/api/health',
    docs: '/api/docs'
  });
});

// Helper to resolve an available index.html
const resolveIndexHtml = () => {
  const directPath = path.join(frontendDistPath, 'index.html');
  if (fs.existsSync(directPath)) return directPath;
  for (const candidate of candidateDistPaths) {
    const candidateFile = path.join(candidate, 'index.html');
    if (fs.existsSync(candidateFile)) return candidateFile;
  }
  return null;
};

// Mount static asset servers for any available dist directories
candidateDistPaths.forEach((distPath) => {
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath, {
      maxAge: '1d',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      }
    }));
  }
});

// Single Page Application (SPA) catch-all handler for all frontend routes
app.get('*', (req, res, next) => {
  if (req.originalUrl.startsWith('/api') || req.originalUrl.startsWith('/health')) {
    return next();
  }
  const indexHtml = resolveIndexHtml();
  if (indexHtml) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(indexHtml);
  }
  next();
});

// 404 Handler for unmatched API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    error: `API Route not found: ${req.method} ${req.originalUrl}`
  });
});

// Fallback 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  if (err.message && err.message.includes('CORS blocked')) {
    return res.status(403).json({
      success: false,
      error: err.message
    });
  }
  logger.error({ err, url: req.originalUrl, method: req.method }, '[Server Error]');
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal Server Error'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`[MedPulse LMS Server] Running on http://127.0.0.1:${PORT}`);
  logger.info(`[Healthcheck] http://127.0.0.1:${PORT}/api/health`);
  logger.info(`[OpenAPI Docs] http://127.0.0.1:${PORT}/api/docs`);
});

// Process Safety Handlers
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, '[Unhandled Rejection]');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, '[Uncaught Exception]');
});

export default app;
