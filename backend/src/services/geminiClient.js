/**
 * Multi-Key Gemini API Client with Load Balancing, Key Rotation & SSE Streaming
 * 
 * Supports automatic rotation across multiple Gemini API keys on 429 (Rate Limit)
 * or 5xx (Service Unavailable) with exponential backoff retry.
 * Sensitive keys are strictly masked in logs and NEVER exposed to clients.
 */

let currentKeyIndex = 0;

/**
 * Retrieve all configured Gemini API keys from environment variables.
 * Supports comma, newline, or whitespace separated keys.
 */
export const getGeminiKeys = () => {
  const rawKeys = [
    process.env.GEMINI_API_KEYS,
    process.env.GEMINI_API_KEY,
    process.env.NOVA_API_KEYS,
    process.env.NOVA_API_KEY
  ].filter(Boolean).join(',');

  const keys = rawKeys
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 5 && !k.includes('your_'));

  return Array.from(new Set(keys));
};

/**
 * Mask an API key for secure logging
 */
export const maskKey = (key = '') => {
  if (!key || key.length < 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
};

/**
 * Delay utility for exponential backoff
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stream Gemini Chat with Key Rotation & Exponential Backoff
 * 
 * @param {Object} options
 * @param {Array<{role: string, content: string}>} options.messages - Sanitized chat history
 * @param {string} [options.systemPrompt] - System instructions defining Nova's personality
 * @param {function(string): void} options.onToken - Callback for each streamed token
 * @param {AbortSignal} [options.signal] - Abort signal for client cancellation
 * @param {number} [options.temperature=0.7] - Creativity / temperature
 * @param {number} [options.maxRetries=3] - Maximum retry attempts across keys
 * @returns {Promise<{ text: string, model: string }>}
 */
export const streamGeminiChat = async ({
  messages,
  systemPrompt,
  onToken,
  signal,
  temperature = 0.7,
  maxRetries = 3,
  fetchFn = fetch
}) => {
  const keys = getGeminiKeys();
  if (keys.length === 0) {
    throw new Error('No valid Gemini API keys configured on the server.');
  }

  const baseUrl = (process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const preferredModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const candidateModels = Array.from(new Set([preferredModel, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3.5-flash']));

  // Format messages into Gemini contents format
  const formattedContents = messages.map((m) => ({
    role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const requestBody = {
    contents: formattedContents,
    generationConfig: {
      temperature,
      maxOutputTokens: 2500
    }
  };

  if (systemPrompt) {
    requestBody.systemInstruction = {
      parts: [{ text: systemPrompt }]
    };
  }

  let lastError = null;
  const totalKeys = keys.length;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Check if client disconnected before starting attempt
    if (signal?.aborted) {
      throw new Error('Client aborted request');
    }

    const key = keys[(currentKeyIndex++) % totalKeys];

    for (const model of candidateModels) {
      try {
        const url = `${baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
        
        const effectiveFetch = fetchFn || fetch;
        const response = await effectiveFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody),
          signal
        });

        // If rate-limited (429) or transient server error (503/500), back off and try next key
        if (response.status === 429 || response.status >= 500) {
          const statusText = response.status === 429 ? 'Rate Limited' : 'Upstream Server Error';
          console.warn(`[GeminiClient] ${statusText} (HTTP ${response.status}) on key ${maskKey(key)} with model ${model}. Attempt ${attempt + 1}/${maxRetries}. Rotating key.`);
          lastError = new Error(`Gemini API returned ${response.status}`);
          break; // Break inner model loop to rotate to next key
        }

        if (!response.ok) {
          const errBody = await response.text();
          // If model not found (404), try next model on same key
          if (response.status === 404) {
            console.warn(`[GeminiClient] Model ${model} not available (404). Trying fallback model.`);
            continue;
          }
          console.warn(`[GeminiClient] Request failed with HTTP ${response.status}: ${errBody.slice(0, 120)}`);
          lastError = new Error(`Gemini request failed: ${response.status}`);
          break;
        }

        // Successfully opened SSE stream from Gemini
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';

        while (true) {
          if (signal?.aborted) {
            reader.cancel();
            throw new Error('Client aborted request');
          }

          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete trailing line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const data = JSON.parse(jsonStr);
              const chunkText = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (chunkText) {
                fullText += chunkText;
                if (typeof onToken === 'function') {
                  onToken(chunkText);
                }
              }
            } catch {
              // Ignore partial JSON frame parsing errors
            }
          }
        }

        // If response ended without errors, return
        if (fullText.length > 0) {
          return { text: fullText, fullText, model };
        }
      } catch (err) {
        if (signal?.aborted || err.name === 'AbortError') {
          throw err;
        }
        console.warn(`[GeminiClient] Stream attempt ${attempt + 1} failed on key ${maskKey(key)}: ${err.message}`);
        lastError = err;
        break; // Try next key
      }
    }

    // Exponential backoff before next attempt: 300ms, 900ms, 2700ms
    if (attempt < maxRetries - 1) {
      const backoffMs = 300 * Math.pow(3, attempt);
      await sleep(backoffMs);
    }
  }

  throw lastError || new Error('Failed to generate response after rotating through available Gemini keys.');
};

/**
 * Generate standard (non-streaming) text content using Gemini with automatic key rotation.
 */
export const generateGeminiContent = async ({
  prompt,
  temperature = 0.2,
  maxOutputTokens = 750
}) => {
  const keys = getGeminiKeys();
  if (keys.length === 0) return null;

  const baseUrl = (process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const preferredModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const fallbackModels = Array.from(new Set([preferredModel, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3.5-flash']));

  const totalKeys = keys.length;
  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const key = keys[(currentKeyIndex++) % totalKeys];

    for (const model of fallbackModels) {
      try {
        const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${key}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature, maxOutputTokens }
          }),
          signal: AbortSignal.timeout(12000)
        });

        if (response.ok) {
          const data = await response.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            return {
              text: text.trim(),
              model,
              keyUsed: maskKey(key)
            };
          }
        }

        if (response.status === 404) continue;
        if (response.status === 429 || response.status >= 500) break;
      } catch (err) {
        console.warn(`[GeminiClient] Fetch error on key ${maskKey(key)} (${err.message})`);
        break;
      }
    }
  }

  return null;
};

/**
 * Generate embedding vector using Gemini with key rotation.
 */
export const generateGeminiEmbedding = async (text) => {
  const keys = getGeminiKeys();
  if (keys.length === 0) return null;

  const baseUrl = (process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const preferredModel = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
  const models = Array.from(new Set([preferredModel, 'gemini-embedding-001']));

  const totalKeys = keys.length;
  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const key = keys[(currentKeyIndex++) % totalKeys];

    for (const model of models) {
      try {
        const url = `${baseUrl}/v1beta/models/${model}:embedContent?key=${key}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: { parts: [{ text: text.substring(0, 2048) }] }
          }),
          signal: AbortSignal.timeout(10000)
        });

        if (response.ok) {
          const data = await response.json();
          if (data.embedding?.values && Array.isArray(data.embedding.values)) {
            return data.embedding.values;
          }
        }

        if (response.status === 429 || response.status >= 500) break;
      } catch {
        break;
      }
    }
  }

  return null;
};
