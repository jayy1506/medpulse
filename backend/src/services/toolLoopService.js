import {
  GEMINI_TOOLS_DECLARATIONS,
  executeTool
} from './toolRegistry.js';
import {
  getGeminiKeys,
  maskKey
} from './geminiClient.js';

const MAX_TOOL_ITERATIONS = 5;

/**
 * Execute tool calling loop with Gemini REST API
 */
export const runGeminiToolLoop = async ({
  messages,
  systemPrompt,
  tools = GEMINI_TOOLS_DECLARATIONS,
  onStatusUpdate,
  onToken,
  signal,
  maxIterations = MAX_TOOL_ITERATIONS
}) => {
  const keys = getGeminiKeys();
  if (keys.length === 0) {
    throw new Error('No valid Gemini API keys configured.');
  }

  const baseUrl = (process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

  // Format initial message contents for Gemini
  const contents = messages.map(m => ({
    role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const executedTools = [];
  let currentKeyIndex = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) {
      throw new Error('Client aborted tool loop');
    }

    const key = keys[currentKeyIndex % keys.length];
    const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${key}`;

    const requestBody = {
      contents,
      tools: [{
        functionDeclarations: tools
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2500
      }
    };

    if (systemPrompt) {
      requestBody.systemInstruction = {
        parts: [{ text: systemPrompt }]
      };
    }

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: signal || AbortSignal.timeout(15000)
      });
    } catch (netErr) {
      console.warn(`[ToolLoop] Request error on key ${maskKey(key)}:`, netErr.message);
      currentKeyIndex++;
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      console.warn(`[ToolLoop] HTTP ${response.status} on key ${maskKey(key)}. Rotating key.`);
      currentKeyIndex++;
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[ToolLoop] API error (${response.status}):`, errText.slice(0, 150));
      currentKeyIndex++;
      continue;
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const candidateParts = candidate?.content?.parts || [];

    // Check if Gemini invoked a function call
    const functionCallPart = candidateParts.find(p => p.functionCall);

    if (functionCallPart && functionCallPart.functionCall) {
      const { name, args } = functionCallPart.functionCall;

      // Stream friendly status event to UI
      const statusLabels = {
        get_current_datetime: 'Checking current date & time...',
        calculator: `Calculating: ${args?.expression || 'expression'}...`,
        web_search: `Searching web for: "${args?.query || ''}"...`,
        search_documents: `Searching uploaded documents for: "${args?.query || ''}"...`
      };

      const statusMsg = statusLabels[name] || `Executing ${name}...`;
      if (onStatusUpdate) {
        onStatusUpdate(statusMsg, name, args);
      }

      console.info(`[ToolLoop] Executing tool: ${name} (iteration ${iteration + 1})`);

      let toolOutput;
      try {
        toolOutput = await executeTool(name, args, 8000);
      } catch (toolErr) {
        toolOutput = { error: toolErr.message };
      }

      executedTools.push({
        name,
        args,
        result: toolOutput
      });

      // Append assistant's functionCall turn to conversation
      contents.push({
        role: 'model',
        parts: [{ functionCall: { name, args: args || {} } }]
      });

      // Append function response turn to conversation
      contents.push({
        role: 'function',
        parts: [{
          functionResponse: {
            name,
            response: { output: toolOutput }
          }
        }]
      });

      // Continue loop for Gemini to evaluate tool response
      continue;
    }

    // No function call returned -> final text response
    const textPart = candidateParts.find(p => p.text);
    const finalText = textPart?.text || '';

    // If onToken is provided, stream the final text in tokens for UI
    if (onToken && finalText) {
      const tokens = finalText.match(/\S+|\s+/g) || [finalText];
      for (const tok of tokens) {
        onToken(tok);
      }
    }

    return {
      text: finalText,
      toolsUsed: executedTools,
      model
    };
  }

  // If loop exceeded max iterations, return summary
  return {
    text: 'Completed tool processing.',
    toolsUsed: executedTools,
    model
  };
};
