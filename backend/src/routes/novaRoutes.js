import express from 'express';
import multer from 'multer';
import {
  handleNovaChatStream,
  handleNovaContentUpload,
  handleListNovaContent,
  handleDeleteNovaContent,
  handleReindexNovaContent,
  handleGetNovaLogs
} from '../controllers/novaChatController.js';
import { verifyFirebaseToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/roleGuard.js';
import { aiRateLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// Multer in-memory storage for content uploads (10 MB limit with type whitelist)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'application/octet-stream'
    ];
    const allowedExtensions = ['.pdf', '.txt', '.md'];
    const isAllowedExt = allowedExtensions.some(ext =>
      file.originalname.toLowerCase().endsWith(ext)
    );

    if (allowedMimes.includes(file.mimetype) || isAllowedExt) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, TXT, and MD files are permitted.'));
    }
  }
});

// Middleware to resolve authenticated user or fall back to student study session
const resolveNovaUser = async (req, res, next) => {
  try {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1].trim();
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (token) {
      const mockRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json() { return this; }
      };
      await verifyFirebaseToken(req, mockRes, () => {});
    }
  } catch {}

  if (!req.user || !req.user.uid) {
    req.user = {
      uid: `student_${Date.now()}`,
      email: 'student@medpulse.edu',
      name: 'Nursing Student',
      role: 'student'
    };
  }
  return next();
};

// 1. Streaming Chat SSE endpoint (accessible to all students, with or without prior auth)
router.post('/chat', resolveNovaUser, aiRateLimiter, handleNovaChatStream);

// 2. Chat history / audit logs (Requires authentication & elevated role)
router.get('/logs', verifyFirebaseToken, requireRole(['admin', 'faculty']), handleGetNovaLogs);

// 3. Content Ingestion endpoints: Strictly restricted to Admin and Faculty
router.post(
  '/content/upload',
  verifyFirebaseToken,
  requireRole(['admin', 'faculty']),
  upload.single('file'),
  handleNovaContentUpload
);

router.get('/content', verifyFirebaseToken, requireRole(['admin', 'faculty']), handleListNovaContent);

router.delete(
  '/content/:identifier',
  verifyFirebaseToken,
  requireRole(['admin', 'faculty']),
  handleDeleteNovaContent
);

router.post(
  '/content/reindex',
  verifyFirebaseToken,
  requireRole(['admin', 'faculty']),
  handleReindexNovaContent
);

export default router;
