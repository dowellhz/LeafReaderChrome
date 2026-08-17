const test = require('node:test');
const assert = require('node:assert/strict');
const { markdown, normalize, variants } = require('../offline-dictionary.js');

test('normalizes common English inflections for offline lookup', () => {
  assert.equal(normalize(' “Running!” '), 'running');
  assert.ok(variants('studies').includes('study'));
  assert.ok(variants('carried').includes('carry'));
});

test('formats offline entries as safe reader markdown', () => {
  const text = markdown({ word:'arsenal', phonetic:'ɑːsənəl', translation:'n. 武器库\n军火库', pos:'n', oxford:true, tag:'cet4' });
  assert.match(text, /## arsenal/);
  assert.match(text, /Oxford 3000/);
  assert.match(text, /- n\. 武器库/);
});
