import test from 'node:test';
import assert from 'node:assert/strict';
import {
  db,
  createConversation,
  listConversations,
  getConversation,
  updateConversationTitle,
  updateConversationSummary,
  deleteConversation,
  addMessage,
  getMessages
} from '../src/services/dbSqlite.js';
import { autoGenerateConversationTitle, manageRollingMemory } from '../src/services/memoryManager.js';

test('Phase 1: Persistent Conversation Memory (SQLite & Memory Manager)', async (t) => {

  const testConvId = `test_conv_${Date.now()}`;

  await t.test('1. Create and retrieve a conversation in SQLite', () => {
    const conv = createConversation(testConvId, 'Test Conversation');
    assert.equal(conv.id, testConvId);
    assert.equal(conv.title, 'Test Conversation');

    const fetched = getConversation(testConvId);
    assert.ok(fetched);
    assert.equal(fetched.id, testConvId);
    assert.equal(fetched.title, 'Test Conversation');
    assert.equal(fetched.messages.length, 0);
  });

  await t.test('2. Add messages and verify retrieval', () => {
    addMessage({
      conversationId: testConvId,
      role: 'user',
      content: 'Explain cardiac anatomy and blood flow'
    });

    addMessage({
      conversationId: testConvId,
      role: 'assistant',
      content: 'The heart has four chambers: right/left atria and right/left ventricles.'
    });

    const msgs = getMessages(testConvId);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[1].role, 'assistant');

    const conv = getConversation(testConvId);
    assert.equal(conv.messages.length, 2);
  });

  await t.test('3. Update conversation title and list conversations', () => {
    updateConversationTitle(testConvId, 'Renamed Cardiac Anatomy');
    const conv = getConversation(testConvId);
    assert.equal(conv.title, 'Renamed Cardiac Anatomy');

    const list = listConversations();
    assert.ok(list.length > 0);
    const found = list.find(c => c.id === testConvId);
    assert.ok(found);
    assert.equal(found.title, 'Renamed Cardiac Anatomy');
    assert.equal(found.message_count, 2);
  });

  await t.test('4. Test rolling memory threshold and summarization trigger', async () => {
    // Add 8 more messages to exceed the threshold
    for (let i = 1; i <= 8; i++) {
      addMessage({
        conversationId: testConvId,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Cardiac study topic turn ${i}`
      });
    }

    const { verbatimMessages, summary } = await manageRollingMemory(testConvId);
    // Verbatim messages should keep last 6 turns
    assert.equal(verbatimMessages.length, 6);
  });

  await t.test('5. Delete conversation cascades to messages', () => {
    const deleted = deleteConversation(testConvId);
    assert.ok(deleted);

    const checkConv = getConversation(testConvId);
    assert.equal(checkConv, null);

    const checkMsgs = getMessages(testConvId);
    assert.equal(checkMsgs.length, 0);
  });

});
