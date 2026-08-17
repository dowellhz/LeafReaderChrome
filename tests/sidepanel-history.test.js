const test = require('node:test');
const assert = require('node:assert/strict');
const { threadFromHistory } = require('../sidepanel-history.js');

test('reconstructs URL-scoped side-panel history from legacy markers and conversations', () => {
  const wanted = 'web:https://example.com/article';
  const annotations = [
    { documentId:wanted, documentTitle:'Article', conversationId:'one', kind:'translation', quote:'First', updatedAt:10 },
    { id:'highlight-one', documentId:wanted, documentTitle:'Article', kind:'highlight', quote:'Remember this', updatedAt:35 },
    { documentId:'web:https://example.com/other', conversationId:'other', kind:'dictionary', quote:'Wrong page', updatedAt:20 }
  ];
  const conversations = {
    'conversation:one': { documentId:wanted, quote:'First', updatedAt:30, messages:[{ role:'assistant', content:'第一' }] },
    'conversation:two': { documentId:wanted, quote:'Second', presentation:'dictionary', updatedAt:40, messages:[{ role:'assistant', content:'第二' }] },
    'conversation:other': { documentId:'web:https://example.com/other', updatedAt:50, messages:[] }
  };
  const thread = threadFromHistory(wanted, 'Current title', annotations, conversations);
  assert.deepEqual(thread.entries.map((entry) => entry.conversationId), ['one', 'record:highlight-one', 'two']);
  assert.equal(thread.entries[0].body, '第一');
  assert.equal(thread.entries[1].title, 'Highlight');
  assert.equal(thread.entries[1].readOnly, true);
  assert.equal(thread.entries[2].title, '单词释义');
  assert.ok(thread.entries.every((entry) => entry.documentId === wanted));
});

test('returns no history when the complete URL does not match', () => {
  const thread = threadFromHistory('web:https://example.com/article?version=2', 'Article', [
    { documentId:'web:https://example.com/article?version=1', conversationId:'one', kind:'translation' }
  ], {});
  assert.equal(thread, null);
});
