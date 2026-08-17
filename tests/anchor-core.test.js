const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTextIndex, cleanText, createAnchor, findAnchorPosition, rangeForAnchor } = require('../anchor-core.js');

test('normalizes visible whitespace consistently', () => {
  assert.equal(cleanText('  one\n\t two  '), 'one two');
});

test('uses prefix and suffix to restore repeated text', () => {
  const text = 'First shared phrase here. Later shared phrase there.';
  assert.equal(findAnchorPosition(text, { exact:'shared phrase', prefix:'Later ', suffix:' there.', position:0 }), 32);
});

test('falls back to stored position when surrounding text changed', () => {
  const text = 'repeat x repeat x repeat';
  assert.equal(findAnchorPosition(text, { exact:'repeat', position:10 }), 9);
});

test('maps DOM text with run segments instead of per-character objects', () => {
  const previousNode = global.Node;
  const previousNodeFilter = global.NodeFilter;
  global.Node = { TEXT_NODE:3 };
  global.NodeFilter = { SHOW_TEXT:4, FILTER_REJECT:2, FILTER_ACCEPT:1 };
  const parentElement = { closest:() => null };
  const nodes = [
    { nodeType:3, nodeValue:'Alpha   ', parentElement },
    { nodeType:3, nodeValue:' beta phrase', parentElement }
  ];
  const documentRef = {
    createTreeWalker() { let cursor = 0; return { nextNode:() => nodes[cursor++] || null }; },
    createRange() { return { setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }, setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; } }; }
  };
  const root = { ownerDocument:documentRef };
  try {
    const index = buildTextIndex(root);
    assert.equal(index.text, 'Alpha beta phrase');
    assert.ok(index.segments.length < index.text.length);
    const selectedRange = { startContainer:nodes[1], startOffset:1, endContainer:nodes[1], endOffset:12, toString:() => 'beta phrase' };
    const anchor = createAnchor(selectedRange, index);
    assert.equal(anchor.position, 6);
    const restored = rangeForAnchor(anchor, index, documentRef);
    assert.equal(restored.startContainer, nodes[1]);
    assert.equal(restored.startOffset, 1);
    assert.equal(restored.endOffset, 12);
  } finally {
    global.Node = previousNode;
    global.NodeFilter = previousNodeFilter;
  }
});
