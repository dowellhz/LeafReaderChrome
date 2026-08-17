const test = require('node:test');
const assert = require('node:assert/strict');
const { canReuseApiKey, endpointIdentity } = require('../settings-core.js');

test('normalizes equivalent endpoint spelling', () => {
  assert.equal(endpointIdentity(' HTTPS://API.EXAMPLE.COM/v1/ '), 'https://api.example.com/v1');
});

test('reuses a local key only for the same provider and endpoint', () => {
  const current = { provider:'openai', endpoint:'https://api.example.com/v1/' };
  assert.equal(canReuseApiKey(current, { provider:'openai', endpoint:'https://API.example.com/v1' }), true);
  assert.equal(canReuseApiKey(current, { provider:'custom', endpoint:'https://api.example.com/v1' }), false);
  assert.equal(canReuseApiKey(current, { provider:'openai', endpoint:'https://other.example.com/v1' }), false);
});
