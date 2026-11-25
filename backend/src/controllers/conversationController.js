import {
  listConversations,
  getConversation,
  createConversation,
  updateConversationTitle,
  deleteConversation
} from '../services/dbSqlite.js';

export const handleGetConversations = (req, res) => {
  try {
    const list = listConversations();
    res.json({ success: true, conversations: list });
  } catch (err) {
    console.error('[ConversationController] list error:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve conversations.' });
  }
};

export const handleGetConversationById = (req, res) => {
  const { id } = req.params;
  try {
    const conv = getConversation(id);
    if (!conv) {
      return res.status(404).json({ success: false, error: 'Conversation not found.' });
    }
    res.json({ success: true, conversation: conv });
  } catch (err) {
    console.error('[ConversationController] getById error:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve conversation details.' });
  }
};

export const handleCreateConversation = (req, res) => {
  const { id, title } = req.body;
  const convId = id || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const created = createConversation(convId, title || 'New chat');
    res.status(201).json({ success: true, conversation: created });
  } catch (err) {
    console.error('[ConversationController] create error:', err);
    res.status(500).json({ success: false, error: 'Failed to create conversation.' });
  }
};

export const handleRenameConversation = (req, res) => {
  const { id } = req.params;
  const { title } = req.body;

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ success: false, error: 'Title is required and must be a non-empty string.' });
  }

  try {
    const updated = updateConversationTitle(id, title.trim());
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Conversation not found.' });
    }
    res.json({ success: true, conversation: updated });
  } catch (err) {
    console.error('[ConversationController] rename error:', err);
    res.status(500).json({ success: false, error: 'Failed to rename conversation.' });
  }
};

export const handleDeleteConversation = (req, res) => {
  const { id } = req.params;
  try {
    const deleted = deleteConversation(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Conversation not found or already deleted.' });
    }
    res.json({ success: true, message: 'Conversation deleted successfully.' });
  } catch (err) {
    console.error('[ConversationController] delete error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete conversation.' });
  }
};
