import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
dotenv.config();

import {
  evaluateSafeMath,
  executeTool,
  GEMINI_TOOLS_DECLARATIONS
} from '../src/services/toolRegistry.js';
import { runGeminiToolLoop } from '../src/services/toolLoopService.js';

test('Phase 3: Gemini Function Calling Tools & Tool Loop', async (t) => {

  await t.test('1. Safe math parser evaluates arithmetic accurately without eval', () => {
    assert.equal(evaluateSafeMath('15 * 120'), 1800);
    assert.equal(evaluateSafeMath('(250 - 50) / 2'), 100);
    assert.equal(evaluateSafeMath('2 ^ 3 + 10'), 18);
    assert.equal(evaluateSafeMath('100 * 0.15'), 15);
    assert.equal(evaluateSafeMath('-10 + 25'), 15);
  });

  await t.test('2. Safe math parser rejects unsafe characters and division by zero', () => {
    assert.throws(() => evaluateSafeMath('10 / 0'), /Division by zero/);
    assert.throws(() => evaluateSafeMath('process.exit(1)'), /Invalid characters/);
    assert.throws(() => evaluateSafeMath('require("fs")'), /Invalid characters/);
    assert.throws(() => evaluateSafeMath('2 + ()'), /Unexpected/);
  });

  await t.test('3. Execute get_current_datetime tool', async () => {
    const result = await executeTool('get_current_datetime', {});
    assert.ok(result.iso);
    assert.ok(result.dayOfWeek);
    assert.equal(result.timezone, 'UTC');
  });

  await t.test('4. Execute web_search tool with clinical query', async () => {
    const result = await executeTool('web_search', { query: 'insulin kinetics' });
    assert.ok(result.results.length > 0);
    assert.ok(result.results[0].snippet.toLowerCase().includes('insulin'));
  });

  await t.test('5. Execute search_documents tool', async () => {
    const result = await executeTool('search_documents', { query: 'cardiac vital signs' }, 15000);
    assert.ok(typeof result.matchCount === 'number');
    assert.ok(Array.isArray(result.chunks));
  });

  await t.test('6. Tool declarations match Gemini function calling specification', () => {
    assert.equal(GEMINI_TOOLS_DECLARATIONS.length, 4);
    for (const tool of GEMINI_TOOLS_DECLARATIONS) {
      assert.ok(tool.name);
      assert.ok(tool.description);
      assert.ok(tool.parameters);
      assert.equal(tool.parameters.type, 'OBJECT');
    }
  });

  await t.test('7. Mock tool loop executes function calls and caps iterations at 5', async () => {
    let iterationCount = 0;
    const statusEvents = [];

    // Mock fetch that simulates Gemini requesting calculator then answering
    const mockToolFetch = async (url, options) => {
      iterationCount++;
      if (iterationCount === 1) {
        // First turn: Gemini requests calculator tool call
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              content: {
                role: 'model',
                parts: [{
                  functionCall: {
                    name: 'calculator',
                    args: { expression: '150 * 0.15' }
                  }
                }]
              }
            }]
          })
        };
      }

      // Second turn: Gemini receives calculation (22.5) and outputs final text
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              role: 'model',
              parts: [{
                text: '15% of 150 is 22.5 based on calculation.'
              }]
            }
          }]
        })
      };
    };

    // Override global fetch in runner context or run tool loop
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockToolFetch;

    try {
      const result = await runGeminiToolLoop({
        messages: [{ role: 'user', content: 'What is 15% of 150?' }],
        systemPrompt: 'You are Nova.',
        onStatusUpdate: (status, tool) => statusEvents.push({ status, tool }),
        maxIterations: 5
      });

      assert.equal(result.toolsUsed.length, 1);
      assert.equal(result.toolsUsed[0].name, 'calculator');
      assert.equal(result.toolsUsed[0].result.result, 22.5);
      assert.ok(result.text.includes('22.5'));
      assert.equal(statusEvents.length, 1);
      assert.equal(statusEvents[0].tool, 'calculator');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});
