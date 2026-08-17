const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSelectionText, prepareParagraphTranslation, restoreParagraphTranslation } = require('../translation-core.js');

test('preserves paragraph boundaries while cleaning selected text', () => {
  assert.equal(normalizeSelectionText(' First  line. \n\n Second\tparagraph. '), 'First line.\n\nSecond paragraph.');
});

test('round-trips model translations as separate paragraphs', () => {
  const prepared = prepareParagraphTranslation('First paragraph.\n\nSecond paragraph.');
  assert.equal(prepared.count, 2);
  assert.equal(prepared.text, '[[P1]] First paragraph.\n\n[[P2]] Second paragraph.');
  assert.equal(restoreParagraphTranslation('[[P1]] 第一段。\n\n[[P2]] 第二段。', prepared.count), '第一段。\n\n第二段。');
});
