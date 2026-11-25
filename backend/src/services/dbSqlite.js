import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbDir = process.env.NOVA_DATA_DIR || path.resolve(__dirname, '../../data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = process.env.NOVA_DB_PATH || path.join(dbDir, 'nova.db');
export const db = new Database(dbPath);

// Enable WAL mode for high concurrency & foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize Phase 1 tables: conversations and messages
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT DEFAULT NULL,
    citations TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at ASC);

  -- Phase 2: Uploaded documents and vector chunks
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS document_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    document_name TEXT NOT NULL,
    page_number INTEGER DEFAULT 1,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
`);

// ----------------- Conversation Operations -----------------

export const listConversations = () => {
  const stmt = db.prepare(`
    SELECT c.id, c.title, c.summary, c.created_at, c.updated_at,
           COUNT(m.id) as message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC
  `);
  return stmt.all();
};

export const getConversation = (id) => {
  const convStmt = db.prepare(`SELECT * FROM conversations WHERE id = ?`);
  const conv = convStmt.get(id);
  if (!conv) return null;

  const msgStmt = db.prepare(`
    SELECT id, conversation_id, role, content, tool_calls, citations, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `);
  const messages = msgStmt.all(id).map(m => ({
    ...m,
    tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
    citations: m.citations ? JSON.parse(m.citations) : null
  }));

  return {
    ...conv,
    messages
  };
};

export const createConversation = (id, title = 'New chat', summary = '') => {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO conversations (id, title, summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `);
  stmt.run(id, title, summary, now, now);
  return { id, title, summary, created_at: now, updated_at: now, messages: [] };
};

export const updateConversationTitle = (id, title) => {
  const stmt = db.prepare(`
    UPDATE conversations
    SET title = ?, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(title, Date.now(), id);
  return getConversation(id);
};

export const updateConversationSummary = (id, summary) => {
  const stmt = db.prepare(`
    UPDATE conversations
    SET summary = ?, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(summary, Date.now(), id);
};

export const deleteConversation = (id) => {
  const stmt = db.prepare(`DELETE FROM conversations WHERE id = ?`);
  const result = stmt.run(id);
  return result.changes > 0;
};

// ----------------- Message Operations -----------------

export const addMessage = ({
  id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  conversationId,
  role,
  content,
  toolCalls = null,
  citations = null,
  createdAt = Date.now()
}) => {
  // Ensure conversation exists
  const existing = db.prepare(`SELECT id FROM conversations WHERE id = ?`).get(conversationId);
  if (!existing) {
    createConversation(conversationId, 'New chat');
  }

  const stmt = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, tool_calls, citations, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    conversationId,
    role,
    content,
    toolCalls ? JSON.stringify(toolCalls) : null,
    citations ? JSON.stringify(citations) : null,
    createdAt
  );

  // Update conversation updated_at
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(createdAt, conversationId);

  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    tool_calls: toolCalls,
    citations,
    created_at: createdAt
  };
};

export const getMessages = (conversationId) => {
  const stmt = db.prepare(`
    SELECT id, conversation_id, role, content, tool_calls, citations, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `);
  return stmt.all(conversationId).map(m => ({
    ...m,
    tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
    citations: m.citations ? JSON.parse(m.citations) : null
  }));
};

// ----------------- Document & Vector Operations (Phase 2) -----------------

export const addDocument = ({
  id = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  name,
  mimeType,
  sizeBytes,
  chunkCount,
  createdAt = Date.now()
}) => {
  const stmt = db.prepare(`
    INSERT INTO documents (id, name, mime_type, size_bytes, chunk_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, name, mimeType, sizeBytes, chunkCount, createdAt);
  return { id, name, mime_type: mimeType, size_bytes: sizeBytes, chunk_count: chunkCount, created_at: createdAt };
};

export const listDocuments = () => {
  const stmt = db.prepare(`SELECT * FROM documents ORDER BY created_at DESC`);
  return stmt.all();
};

export const getDocument = (id) => {
  const stmt = db.prepare(`SELECT * FROM documents WHERE id = ?`);
  return stmt.get(id);
};

export const deleteDocument = (id) => {
  const stmt = db.prepare(`DELETE FROM documents WHERE id = ?`);
  const result = stmt.run(id);
  return result.changes > 0;
};

export const addDocumentChunks = (chunks) => {
  const stmt = db.prepare(`
    INSERT INTO document_chunks (id, document_id, document_name, page_number, chunk_index, content, embedding, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      stmt.run(
        r.id || `chk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        r.document_id,
        r.document_name,
        r.page_number || 1,
        r.chunk_index,
        r.content,
        typeof r.embedding === 'string' ? r.embedding : JSON.stringify(r.embedding),
        r.created_at || Date.now()
      );
    }
  });

  insertMany(chunks);
};

export const getAllChunksWithEmbeddings = () => {
  const stmt = db.prepare(`
    SELECT id, document_id, document_name, page_number, chunk_index, content, embedding
    FROM document_chunks
  `);
  return stmt.all().map(c => ({
    ...c,
    embedding: JSON.parse(c.embedding)
  }));
};

