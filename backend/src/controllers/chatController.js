import { streamGeminiChat } from '../services/geminiClient.js';
import { queryChapterRAG } from '../services/ragService.js';
import { retrieveRelevantDocumentChunks } from '../services/ragDocumentService.js';
import { runGeminiToolLoop } from '../services/toolLoopService.js';
import {
  addMessage,
  getConversation,
  createConversation,
  getMessages
} from '../services/dbSqlite.js';
import {
  autoGenerateConversationTitle,
  manageRollingMemory
} from '../services/memoryManager.js';

// In-memory session store: Map<sessionId, { history: Array<{role: string, content: string}>, lastActive: number }>
const sessionStore = new Map();

// Session expiry: 24 hours
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TURNS = parseInt(process.env.NOVA_MAX_TURNS, 10) || 12;
const MAX_MESSAGE_LENGTH = 4000;
const ALLOWED_ROLES = new Set(['user', 'assistant', 'model', 'system']);

// Periodic garbage collection for expired sessions (every 30 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessionStore.entries()) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessionStore.delete(sessionId);
    }
  }
}, 30 * 60 * 1000).unref();

export const NOVA_SYSTEM_PROMPT = `You are Nova AI, an expert, supportive clinical nursing educator and medical science tutor.

Personality & Pedagogy:
- Helpful, friendly, empathetic, concise, and clinically accurate.
- Honest about uncertainty: if medical evidence is divided or clinical data is insufficient, state so clearly and recommend consulting primary protocols.
- Deliver high-yield NCLEX rationales, pathophysiology mechanisms, and practical clinical pearls.
- Use clean GitHub-flavored markdown: bold key terms, structured bullet lists, tables for comparisons, and code blocks for SBAR protocols.
- Keep answers focused, engaging, and directly responsive without repetitive filler or unnecessary disclaimers.`;

/**
 * Handle Streaming Chat Request via SSE
 * POST /api/chat
 * Body: { messages: Array<{role: string, content: string}>, sessionId?: string }
 */
export const handleChatStream = async (req, res) => {
  const { messages, sessionId, enableRag } = req.body;

  // 1. Input Validation
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Invalid request: "messages" must be a non-empty array of message objects.'
    });
  }

  // Validate each message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') {
      return res.status(400).json({
        success: false,
        error: `Message at index ${i} is invalid.`
      });
    }

    if (!ALLOWED_ROLES.has(msg.role)) {
      return res.status(400).json({
        success: false,
        error: `Invalid role "${msg.role}" at index ${i}. Allowed roles: user, assistant, model, system.`
      });
    }

    if (typeof msg.content !== 'string' || msg.content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: `Message content at index ${i} must be a non-empty string.`
      });
    }

    if (msg.content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `Message content at index ${i} exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters.`
      });
    }
  }

  // 2. Session History Management
  const currentSessionId = sessionId && typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.trim()
    : 'default-session';

  let session = sessionStore.get(currentSessionId);
  if (!session) {
    session = {
      history: [],
      lastActive: Date.now()
    };
    sessionStore.set(currentSessionId, session);
  } else {
    session.lastActive = Date.now();
  }

  // Extract latest user message
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const userQuery = lastUserMessage?.content || '';

  // 2. Persistent SQLite Conversation & Message Storage (Phase 1)
  let conv = getConversation(currentSessionId);
  if (!conv) {
    conv = createConversation(currentSessionId, 'New chat');
  }

  // Record user message into SQLite
  addMessage({
    conversationId: currentSessionId,
    role: 'user',
    content: userQuery
  });

  // Auto-generate title if this is the first message or titled "New chat"
  if (conv.title === 'New chat' || !conv.title) {
    autoGenerateConversationTitle(currentSessionId, userQuery).catch((err) => {
      console.warn('[ChatController] Background title generation error:', err.message);
    });
  }

  // Manage rolling conversation memory (token budget & rolling summaries)
  const { verbatimMessages, summary } = await manageRollingMemory(currentSessionId);

  // 3. Document RAG Retrieval (Phase 2)
  let docChunks = [];
  let docContextPrompt = '';
  if (useDocuments) {
    try {
      docChunks = await retrieveRelevantDocumentChunks({
        query: userQuery,
        topK: 5,
        minSimilarity: 0.40
      });
    } catch (err) {
      console.warn('[ChatController] Document RAG error:', err.message);
    }

    if (docChunks.length > 0) {
      const formattedChunks = docChunks
        .map(c => `[Source: ${c.documentName}, p. ${c.pageNumber}]\n${c.content}`)
        .join('\n\n');
      docContextPrompt = `\n\n[UPLOADED DOCUMENTS CONTEXT]:\n${formattedChunks}\n\nSTRICT INSTRUCTIONS FOR UPLOADED DOCUMENTS:\n1. Answer ONLY using the facts present in the uploaded document context above.\n2. If the user query cannot be answered directly from the uploaded documents, state clearly: "I couldn't find that in your documents." Do NOT speculate or assume facts outside this context.\n3. Always cite sources like [filename.pdf, p. 1].`;
    } else {
      docContextPrompt = `\n\n[UPLOADED DOCUMENTS CONTEXT]:\nNo matching information was found in your uploaded documents for this query.\n\nSTRICT INSTRUCTIONS FOR UPLOADED DOCUMENTS:\nState clearly: "I couldn't find that in your documents." Do not speculate or answer from outside knowledge.`;
    }
  }

  // 4. Optional Curriculum RAG Knowledge Retrieval
  let ragContextPrompt = '';
  const isRagEnabled = enableRag ?? (process.env.ENABLE_RAG === 'true');
  if (isRagEnabled && userQuery && !useDocuments) {
    try {
      const ragResult = await queryChapterRAG({ query: userQuery, mode: 'strict' });
      if (ragResult && ragResult.answer) {
        ragContextPrompt = `\n\nVerified Curriculum Reference:\n${ragResult.answer}\nUse the reference above when directly applicable.`;
      }
    } catch {
      // Continue gracefully if optional RAG retrieval encounters an issue
    }
  }

  // Combine system instructions with rolling conversation summary
  let fullSystemPrompt = `${NOVA_SYSTEM_PROMPT}`;
  if (summary) {
    fullSystemPrompt += `\n\n[Previous Conversation Summary]:\n${summary}`;
  }
  if (docContextPrompt) {
    fullSystemPrompt += docContextPrompt;
  }
  if (ragContextPrompt) {
    fullSystemPrompt += ragContextPrompt;
  }

  // Use verbatim messages from rolling memory (or fallback to trimmed request messages)
  const contextMessages = verbatimMessages.length > 0 ? verbatimMessages : messages.slice(-MAX_TURNS);

  // 5. Initialize Server-Sent Events (SSE) Stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  // Setup abort controller for client disconnect
  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  const citations = docChunks.map(c => ({
    document: c.documentName,
    page: c.pageNumber,
    chunkIndex: c.chunkIndex,
    similarity: Math.round(c.similarity * 100) / 100
  }));

  try {
    let resultText = '';
    let executedTools = [];
    let usedModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

    // Tool loop or standard streaming
    if (useTools !== false) {
      const toolLoopResult = await runGeminiToolLoop({
        messages: contextMessages,
        systemPrompt: fullSystemPrompt,
        signal: abortController.signal,
        onStatusUpdate: (status, tool, toolArgs) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ status, tool, args: toolArgs })}\n\n`);
          }
        },
        onToken: (token) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          }
        }
      });
      resultText = toolLoopResult.text;
      executedTools = toolLoopResult.toolsUsed;
      usedModel = toolLoopResult.model;
    } else {
      const streamResult = await streamGeminiChat({
        messages: contextMessages,
        systemPrompt: fullSystemPrompt,
        signal: abortController.signal,
        onToken: (token) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          }
        }
      });
      resultText = streamResult.text;
      usedModel = streamResult.model;
    }

    // Persist assistant reply to SQLite with tool calls and citations
    addMessage({
      conversationId: currentSessionId,
      role: 'assistant',
      content: resultText,
      toolCalls: executedTools.length > 0 ? executedTools : null,
      citations: citations.length > 0 ? citations : null
    });

    // Update in-memory session history fallback
    session.history.push({ role: 'user', content: userQuery });
    session.history.push({ role: 'assistant', content: resultText });
    if (session.history.length > MAX_TURNS * 2) {
      session.history = session.history.slice(-MAX_TURNS * 2);
    }

    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({
        done: true,
        fullText: resultText,
        toolsUsed: executedTools,
        citations,
        model: usedModel
      })}\n\n`);
      res.end();
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      return;
    }

    console.error('[ChatController Error]', err.message);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: 'Nova is temporarily experiencing heavy traffic. Please try your question again in a moment.'
      });
    }

    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: 'Connection interrupted. Please click Retry to ask again.' })}\n\n`);
      res.end();
    }
  }
};

/**
 * Get Session History
 * GET /api/chat/session/:sessionId
 */
export const getSessionHistory = (req, res) => {
  const { sessionId } = req.params;
  const session = sessionStore.get(sessionId);
  return res.status(200).json({
    success: true,
    sessionId,
    history: session ? session.history : []
  });
};

/**
 * Clear Session History
 * DELETE /api/chat/session/:sessionId
 */
export const clearSessionHistory = (req, res) => {
  const { sessionId } = req.params;
  sessionStore.delete(sessionId);
  return res.status(200).json({
    success: true,
    message: `Session ${sessionId} history cleared successfully.`
  });
};
