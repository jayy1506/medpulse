import { generateGeminiContent } from './geminiClient.js';
import {
  getConversation,
  updateConversationTitle,
  updateConversationSummary,
  getMessages
} from './dbSqlite.js';

const KEEP_VERBATIM_MESSAGES = 6;
const TOKEN_BUDGET_THRESHOLD_TURNS = 8; // ~8 messages triggers summarization

/**
 * Auto-generate a short 3-5 word conversation title from the first message
 */
export const autoGenerateConversationTitle = async (conversationId, firstUserMessage) => {
  if (!firstUserMessage) return 'New chat';

  try {
    const prompt = `Generate a short, concise 3 to 5 word title for a clinical study chat that begins with this user message. Do not use quotes, punctuation, or words like "Chat about":
"${firstUserMessage.slice(0, 200)}"`;

    const res = await generateGeminiContent({ prompt, temperature: 0.3, maxOutputTokens: 25 });
    let title = res?.text?.trim().replace(/^["']|["']$/g, '').replace(/[.\n]/g, '').trim();

    if (!title || title.length < 3 || title.length > 60) {
      title = firstUserMessage.slice(0, 30).trim() + (firstUserMessage.length > 30 ? '...' : '');
    }

    updateConversationTitle(conversationId, title);
    return title;
  } catch (err) {
    console.warn('[MemoryManager] Title generation error, using fallback:', err.message);
    const fallbackTitle = firstUserMessage.slice(0, 30).trim() + (firstUserMessage.length > 30 ? '...' : '');
    updateConversationTitle(conversationId, fallbackTitle);
    return fallbackTitle;
  }
};

/**
 * Long-conversation memory management:
 * When conversation exceeds message threshold, keep last N verbatim and create a rolling summary of older turns.
 */
export const manageRollingMemory = async (conversationId) => {
  const conv = getConversation(conversationId);
  if (!conv) return { verbatimMessages: [], summary: '' };

  const allMessages = conv.messages || [];

  if (allMessages.length <= TOKEN_BUDGET_THRESHOLD_TURNS) {
    return {
      verbatimMessages: allMessages,
      summary: conv.summary || ''
    };
  }

  // Need summarization
  const olderMessages = allMessages.slice(0, allMessages.length - KEEP_VERBATIM_MESSAGES);
  const verbatimMessages = allMessages.slice(allMessages.length - KEEP_VERBATIM_MESSAGES);

  // Check if there are newly unsummarized messages
  const olderTranscript = olderMessages
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n');

  try {
    const previousSummary = conv.summary ? `Previous Summary:\n${conv.summary}\n\n` : '';
    const summaryPrompt = `You are an AI assistant maintaining a rolling summary of a medical/nursing conversation.
${previousSummary}New conversation turns to incorporate:
${olderTranscript}

Task: Write a concise, factual summary (under 120 words) preserving key medical topics discussed, patient scenarios, NCLEX questions covered, and user context. Focus only on essential facts.`;

    const summaryResult = await generateGeminiContent({
      prompt: summaryPrompt,
      temperature: 0.2,
      maxOutputTokens: 200
    });

    const newSummary = summaryResult?.text?.trim() || conv.summary || '';
    if (newSummary) {
      updateConversationSummary(conversationId, newSummary);
    }

    return {
      verbatimMessages,
      summary: newSummary
    };
  } catch (err) {
    console.warn('[MemoryManager] Summarization error, falling back to existing summary:', err.message);
    return {
      verbatimMessages,
      summary: conv.summary || ''
    };
  }
};
