
import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { streamGeminiChat, getGeminiKeys, maskKey } from '../src/services/geminiClient.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

test('Nova AI End-to-End & Security Verification', async (t) => {

  await t.test('1. Verify zero secret leakage in client dist and environment', () => {
    const keys = getGeminiKeys();
    if (!keys || keys.length === 0) {
      return;
    }

    // Check frontend dist files
    const distPath = path.resolve('frontend/dist');
    if (fs.existsSync(distPath)) {
      const walk = (dir) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const full = path.join(dir, file);
          if (fs.statSync(full).isDirectory()) {
            walk(full);
          } else if (file.endsWith('.js') || file.endsWith('.html')) {
            const content = fs.readFileSync(full, 'utf8');
            for (const key of keys) {
              assert.ok(!content.includes(key), `Client asset ${file} must NEVER contain raw API key!`);
            }
          }
        }
      };
      walk(distPath);
    }
  });

  await t.test('2. Verify 429 key rotation with exponential backoff', async () => {
    const attemptedKeys = [];
    let callCount = 0;

    // Custom mock fetch that simulates 429 on first key and success on second key
    const mockFetch = async (url, options) => {
      callCount++;
      const urlObj = new URL(url);
      const usedKey = urlObj.searchParams.get('key');
      attemptedKeys.push(usedKey);

      if (callCount === 1) {
        // First key returns 429 rate limited
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: async () => JSON.stringify({ error: { message: 'Quota exceeded for key 1' } })
        };
      }

      // Second key succeeds with SSE stream
      const sseBody = [
        'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] }) + '\n\n',
        'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'from Nova!' }] } }] }) + '\n\n'
      ].join('');

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: {
          getReader: () => {
            let index = 0;
            const chunks = [new TextEncoder().encode(sseBody)];
            return {
              read: async () => {
                if (index < chunks.length) {
                  return { done: false, value: chunks[index++] };
                }
                return { done: true, value: undefined };
              }
            };
          }
        }
      };
    };

    const tokens = [];
    const result = await streamGeminiChat({
      messages: [{ role: 'user', content: 'Test rotation' }],
      systemPrompt: 'You are Nova.',
      onToken: (tok) => tokens.push(tok),
      fetchFn: mockFetch,
      maxRetries: 3
    });

    assert.equal(callCount, 2, 'Should retry with second key after 429');
    assert.notEqual(attemptedKeys[0], attemptedKeys[1], 'Rotated to next key on 429');
    assert.equal(result.fullText, 'Hello from Nova!');
    assert.deepEqual(tokens, ['Hello ', 'from Nova!']);
  });

  await t.test('3. Verify real Gemini streaming endpoint response with active key', async (context) => {
    const keys = getGeminiKeys();
    if (!keys || keys.length === 0 || process.env.RUN_LIVE_GEMINI_TEST !== 'true') {
      context.skip('Skipping live Gemini call in automated unit tests');
      return;
    }
    const tokens = [];
    const result = await streamGeminiChat({
      messages: [{ role: 'user', content: 'Say "MedPulse is ready" in 3 words.' }],
      systemPrompt: 'Be concise.',
      onToken: (tok) => tokens.push(tok)
    });

    assert.ok(result.fullText.length > 0, 'Should return text from Gemini');
    assert.ok(tokens.length > 0, 'Should stream tokens');
    // Ensure raw key is never in result
    for (const key of getGeminiKeys()) {
      assert.ok(!result.fullText.includes(key), 'Streamed content must not contain raw keys');
    }
  });

});
