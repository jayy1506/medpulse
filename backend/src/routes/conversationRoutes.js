import express from 'express';
import {
  handleGetConversations,
  handleGetConversationById,
  handleCreateConversation,
  handleRenameConversation,
  handleDeleteConversation
} from '../controllers/conversationController.js';

const router = express.Router();

// GET /api/conversations - List all past chats
router.get('/', handleGetConversations);

// POST /api/conversations - Create a new chat
router.post('/', handleCreateConversation);

// GET /api/conversations/:id - Get conversation by ID with all messages
router.get('/:id', handleGetConversationById);

// PATCH /api/conversations/:id - Rename a conversation
router.patch('/:id', handleRenameConversation);

// DELETE /api/conversations/:id - Delete a conversation
router.delete('/:id', handleDeleteConversation);

export default router;
