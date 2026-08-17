const test = require('node:test');
const assert = require('node:assert/strict');
const { build, search, terms } = require('../search-core.js');

test('ranks the most relevant English passage and reports coverage', () => {
  const index = build('LeafReader saves notes and vocabulary locally.\n\nThe side panel keeps translation conversations and follow-up answers.');
  const result = search(index, 'Where are translation conversations saved?');
  assert.match(result[0].text, /translation conversations/i);
  assert.ok(result[0].coverage > 0);
});

test('matches Chinese questions through overlapping Han terms', () => {
  const index = build('词库会保存查询过的单词和释义。\n\n阅读器支持页面内搜索和朗读。');
  const result = search(index, '单词释义保存在哪里');
  assert.match(result[0].text, /单词和释义/);
  assert.ok(terms('单词释义').includes('单词'));
});
