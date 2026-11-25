import { classifyScope, CANNED_REPLIES } from '../services/novaScopeService.js';
import { retrieveCurriculumChunks } from '../services/novaRetrievalService.js';
import { streamGeminiChat } from '../services/geminiClient.js';
import { NovaChatLog } from '../models/NovaChatLog.js';
import {
  indexUploadedCurriculumFile,
  listIndexedCurriculumMaterials,
  deleteCurriculumContent,
  seedCanonicalCurriculum
} from '../services/novaContentService.js';

export const NOVA_STUDY_SYSTEM_PROMPT = `You are Nova, the nursing study assistant for MedPulse.
Your role is to help nursing students master Anatomy, Physiology, Clinical Biochemistry, and Applied Nutrition.

STRICT OPERATING RULES:
1. Ground your response EXCLUSIVELY and ACCURATELY on the Verified Course Excerpts provided below.
2. If the excerpts do not contain the answer or are insufficient, state clearly: "I couldn't find this in the course material. Please check with your faculty." Never guess, extrapolate, or invent facts from general knowledge.
3. NEVER invent numbers, lab reference ranges, drug dosages, or clinical guidelines not explicitly stated in the excerpts.
4. Structure your response with clear, student-friendly short headings and bullet points for maximum clinical clarity.
5. At the end of your response, list the cited course sources (Subject, Chapter, Section, Page).
6. If asked who you are, state: "I am Nova, the nursing study assistant for MedPulse." Never mention external model providers.`;

/**
 * Streaming SSE Chat Endpoint for Nova
 * POST /api/nova/chat
 * Body: { messages?: Array<{role, content}>, query?: string, subject?: string, chapter?: string, allChapters?: boolean }
 */
export const handleNovaChatStream = async (req, res) => {
  const startTime = Date.now();
  const student = req.user;

  // 1. Authentication Guard (Verified by middleware)
  if (!student || !student.uid) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Authentication required.'
    });
  }

  const {
    messages,
    query: directQuery,
    subject = 'All',
    chapter = '',
    allChapters = false
  } = req.body;

  // Extract student query
  let userQuery = (directQuery || '').trim();
  if (!userQuery && Array.isArray(messages) && messages.length > 0) {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    userQuery = lastUserMsg?.content?.trim() || '';
  }

  if (!userQuery) {
    return res.status(400).json({
      success: false,
      error: 'Query or messages array with at least one user message is required.'
    });
  }

  // Set SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();

  const sendSSE = (data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  try {
    sendSSE({ status: 'Nova is analyzing your question...' });

    // 2. Scope Gate (cheap Gemini call with temp 0 + JSON)
    const scopeResult = await classifyScope(userQuery);
    const scope = scopeResult.scope;

    // Handle anything other than in_scope immediately with exact required replies
    if (scope !== 'in_scope') {
      const cannedReply = scopeResult.cannedReply || CANNED_REPLIES[scope] || CANNED_REPLIES.out_of_scope;
      sendSSE({ token: cannedReply });

      // Persist to MongoDB ChatLog
      const latencyMs = Date.now() - startTime;
      await NovaChatLog.create({
        userId: student.uid || String(student.id || student._id),
        userEmail: student.email || '',
        role: student.role || 'student',
        subject: subject || 'All',
        chapter: chapter || '',
        query: userQuery,
        scope,
        response: cannedReply,
        retrievedChunkIds: [],
        citations: [],
        latencyMs
      }).catch(err => console.warn('[NovaChatLog Error]:', err.message));

      sendSSE({
        done: true,
        scope,
        fullText: cannedReply,
        citations: [],
        specialNotice: scope === 'out_of_scope' || scope === 'unsafe_personal_medical'
      });
      return res.end();
    }

    // 3. Retrieval Engine
    sendSSE({ status: 'Nova is searching course material...' });

    const retrievalResult = await retrieveCurriculumChunks({
      query: userQuery,
      subject,
      chapter,
      allChapters: Boolean(allChapters),
      topK: 5,
      minSimilarity: 0.38
    });

    // If no chunk passed threshold, return exact required refusal
    if (!retrievalResult.found || retrievalResult.chunks.length === 0) {
      const notFoundReply = CANNED_REPLIES.not_found;
      sendSSE({ token: notFoundReply });

      const latencyMs = Date.now() - startTime;
      if (student?.uid) {
        NovaChatLog.create({
          userId: student.uid || String(student.id || student._id),
          userEmail: student.email || '',
          role: student.role || 'student',
          subject: subject || 'All',
          chapter: chapter || '',
          query: userQuery,
          scope: 'in_scope',
          response: notFoundReply,
          retrievedChunkIds: [],
          citations: [],
          latencyMs
        }).catch(err => console.warn('[NovaChatLog Error]:', err.message));
      }

      sendSSE({
        done: true,
        scope: 'in_scope',
        fullText: notFoundReply,
        citations: [],
        notFoundInMaterial: true
      });
      return res.end();
    }

    // 4. Answer Generation: Assemble strict prompt and stream
    sendSSE({ status: 'Nova is generating your clinical explanation...' });

    const contextFormatted = retrievalResult.chunks
      .map((c, i) => `[Source ${i + 1} | ${c.subject} - Chapter: ${c.chapter} | Section: ${c.subtopic || 'General'} | Page ${c.pageNumber}]\n${c.text}`)
      .join('\n\n');

    const promptWithContext = `${NOVA_STUDY_SYSTEM_PROMPT}

VERIFIED COURSE EXCERPTS:
${contextFormatted}

STUDENT QUESTION:
${userQuery}`;

    let fullAnswer = '';
    const geminiResult = await streamGeminiChat({
      messages: [{ role: 'user', content: promptWithContext }],
      systemPrompt: NOVA_STUDY_SYSTEM_PROMPT,
      temperature: 0.2,
      signal: abortController.signal,
      onToken: (token) => {
        fullAnswer += token;
        sendSSE({ token });
      }
    });

    const finalAnswer = fullAnswer || geminiResult.text || '';
    const latencyMs = Date.now() - startTime;

    // 5. Citations & Logging
    const chunkIds = retrievalResult.chunks.map(c => c.chunkId || String(c._id));

    if (student?.uid) {
      NovaChatLog.create({
        userId: student.uid || String(student.id || student._id),
        userEmail: student.email || '',
        role: student.role || 'student',
        subject: subject || 'All',
        chapter: chapter || '',
        query: userQuery,
        scope: 'in_scope',
        response: finalAnswer,
        retrievedChunkIds: chunkIds,
        citations: retrievalResult.citations,
        latencyMs
      }).catch(err => console.warn('[NovaChatLog Error]:', err.message));
    }

    sendSSE({
      done: true,
      scope: 'in_scope',
      fullText: finalAnswer,
      citations: retrievalResult.citations,
      model: geminiResult.model || 'gemini-3.5-flash'
    });

    res.end();
  } catch (err) {
    if (abortController.signal.aborted) return;
    console.error('[Nova Chat Error]:', err);

    if (!res.writableEnded) {
      sendSSE({ error: 'Connection interrupted. Please click Retry to ask Nova again.' });
      res.end();
    }
  }
};

/**
 * Content Ingestion Endpoint (Admin & Faculty Only)
 * POST /api/nova/content/upload
 */
export const handleNovaContentUpload = async (req, res) => {
  try {
    const file = req.file;
    const { subject, chapter, subtopic, pageNumber } = req.body;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Please upload a PDF, TXT, or MD document.'
      });
    }

    if (!subject || !chapter) {
      return res.status(400).json({
        success: false,
        error: 'Subject and chapter are required metadata for curriculum indexing.'
      });
    }

    const result = await indexUploadedCurriculumFile({
      file,
      subject,
      chapter,
      subtopic: subtopic || '',
      pageNumber: parseInt(pageNumber, 10) || 1
    });

    return res.status(201).json({
      success: true,
      message: `Successfully indexed ${result.chunkCount} course chunks for ${subject}: ${chapter}.`,
      data: result
    });
  } catch (err) {
    console.error('[Nova Content Upload Error]:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to ingest course content.',
      details: err.message
    });
  }
};

/**
 * List Indexed Curriculum Content
 * GET /api/nova/content
 */
export const handleListNovaContent = async (req, res) => {
  try {
    const materials = await listIndexedCurriculumMaterials();
    return res.status(200).json({
      success: true,
      count: materials.length,
      materials
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to list curriculum content.',
      details: err.message
    });
  }
};

/**
 * Delete Indexed Curriculum Content
 * DELETE /api/nova/content/:identifier
 */
export const handleDeleteNovaContent = async (req, res) => {
  try {
    const { identifier } = req.params;
    const result = await deleteCurriculumContent(identifier);
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to delete curriculum content.',
      details: err.message
    });
  }
};

/**
 * Reindex / Seed Canonical Curriculum
 * POST /api/nova/content/reindex
 */
export const handleReindexNovaContent = async (req, res) => {
  try {
    const result = await seedCanonicalCurriculum();
    return res.status(200).json({
      success: true,
      message: 'Canonical nursing curriculum successfully indexed.',
      ...result
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to reindex curriculum.',
      details: err.message
    });
  }
};

/**
 * Student / Faculty Chat Audit Logs
 * GET /api/nova/logs
 */
export const handleGetNovaLogs = async (req, res) => {
  try {
    const user = req.user;
    const filter = {};

    // Students only view their own logs; admin & faculty can view all
    if (user.role === 'student') {
      filter.userId = user.uid || String(user.id || user._id);
    } else if (req.query.userId) {
      filter.userId = req.query.userId;
    }

    if (req.query.scope) {
      filter.scope = req.query.scope;
    }

    const logs = await NovaChatLog.find(filter)
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();

    return res.status(200).json({
      success: true,
      count: logs.length,
      logs
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch Nova chat logs.',
      details: err.message
    });
  }
};
