const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('record collections are mutated only by the background repository', () => {
  for (const name of ['content.js', 'reader.js', 'sidepanel.js']) {
    const source = read(name);
    assert.doesNotMatch(source, /chrome\.storage\.local\.set\(\{\s*(?:annotations|vocabulary|aiConversations|sidePanelThreads)\b/);
  }
  assert.match(read('background.js'), /type === 'STORAGE_MUTATION'/);
});

test('shared anchor code loads before content and reader code', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.content_scripts[0].js, ['tts-core.js', 'anchor-core.js', 'content.js']);
  assert.match(read('reader.html'), /anchor-core\.js"><\/script><script src="reader\.js/);
});
