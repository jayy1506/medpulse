import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
dotenv.config();

import { handleChatStream, getSessionHistory, clearSessionHistory } from '../src/controllers/chatController.js';
import { getGeminiKeys, maskKey } from '../src/services/geminiClient.js';

const createMockReqRes = (body = {}, params = {}) => {
  const req = {
    body,
    params,
    on: () => {}
  };
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    writableEnded: false,
    writtenData: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      this.writtenData += chunk;
      return true;
    },
    end() {
      this.writableEnded = true;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  return { req, res };
};

describe('Nova AI Chat Controller Tests', () => {
  test('rejects request when messages is not an array', async () => {
    const { req, res } = createMockReqRes({ messages: 'hello' });
    await handleChatStream(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /messages.*non-empty array/i);
  });

  test('rejects request when messages array is empty', async () => {
    const { req, res } = createMockReqRes({ messages: [] });
    await handleChatStream(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  });

  test('rejects message with unauthorized role', async () => {
    const { req, res } = createMockReqRes({
      messages: [{ role: 'hacker', content: 'hello' }]
    });
    await handleChatStream(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /invalid role/i);
  });

  test('rejects message exceeding max character length', async () => {
    const longString = 'x'.repeat(4500);
    const { req, res } = createMockReqRes({
      messages: [{ role: 'user', content: longString }]
    });
    await handleChatStream(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /exceeds maximum length/i);
  });

  test('session history management: returns empty array for new session and clears successfully', () => {
    const testSessionId = `test-sess-${Date.now()}`;
    const { req: getReq, res: getRes } = createMockReqRes({}, { sessionId: testSessionId });
    getSessionHistory(getReq, getRes);

    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.body.success, true);
    assert.deepEqual(getRes.body.history, []);

    const { req: delReq, res: delRes } = createMockReqRes({}, { sessionId: testSessionId });
    clearSessionHistory(delReq, delRes);

    assert.equal(delRes.statusCode, 200);
    assert.equal(delRes.body.success, true);
  });

  test('maskKey safely masks keys without leaking raw secret', () => {
    const rawKey = 'mock_sample_secret_key_1234567890_test';
    const masked = maskKey(rawKey);
    assert.ok(!masked.includes(rawKey));
    assert.equal(masked, `${rawKey.slice(0, 4)}...${rawKey.slice(-4)}`);
  });

  test('getGeminiKeys returns unique list of valid keys', () => {
    const originalKeys = process.env.GEMINI_API_KEYS;
    try {
      process.env.GEMINI_API_KEYS = 'mock_key_alpha_12345,mock_key_beta_67890,mock_key_alpha_12345';
      const keys = getGeminiKeys();
      assert.ok(Array.isArray(keys));
      assert.ok(keys.length >= 2);
      // Ensure no duplicates
      const unique = new Set(keys);
      assert.equal(unique.size, keys.length);
    } finally {
      if (originalKeys !== undefined) {
        process.env.GEMINI_API_KEYS = originalKeys;
      } else {
        delete process.env.GEMINI_API_KEYS;
      }
    }
  });
});
