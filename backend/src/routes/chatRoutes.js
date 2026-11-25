import express from 'express';
import rateLimit from 'express-rate-limit';
import { handleChatStream, getSessionHistory, clearSessionHistory } from '../controllers/chatController.js';

const router = express.Router();

// Rate limiter for Nova Chat streaming endpoint: 60 requests per 15 minutes per IP
const chatRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many chat requests from this IP address. Please slow down and try again in a few minutes.'
  }
});

// POST /api/chat - Stream chat response via SSE
router.post('/', chatRateLimiter, handleChatStream);

// GET /api/chat/session/:sessionId - Retrieve stored session history
router.get('/session/:sessionId', getSessionHistory);

// DELETE /api/chat/session/:sessionId - Clear conversation history for a session
router.delete('/session/:sessionId', clearSessionHistory);

export default router;
