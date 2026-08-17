const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function repositoryHarness() {
  const data = {};
  const listeners = [];
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const local = {
    async get(keys) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.map((key) => [key, clone(data[key])]).filter(([, value]) => value !== undefined));
    },
    async set(values) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      Object.assign(data, clone(values));
    }
  };
  const event = { addListener(listener) { listeners.push(listener); } };
  const chrome = {
    runtime:{ getURL:(value) => value, onMessage:event },
    storage:{ local, session:{ get:async () => ({}), set:async () => {}, remove:async () => {} } },
    action:{ onClicked:event }, commands:{ onCommand:event },
    tabs:{ onUpdated:event, onActivated:event, query:async () => [], create:async () => {}, sendMessage:async () => {}, get:async () => null },
    sidePanel:{ setOptions:async () => {}, open:async () => {} },
    i18n:{ getUILanguage:() => 'en-US' }
  };
  const context = vm.createContext({ chrome, console, setTimeout, clearTimeout, AbortController, URL, fetch:async () => ({ json:async () => ({}) }) });
  const source = fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.repository = { enqueueStorageMutation, mutateStorage };`, context);
  return { data, repository:context.repository };
}

test('serializes concurrent record additions without losing either record', async () => {
  const { data, repository } = repositoryHarness();
  await Promise.all([
    repository.enqueueStorageMutation(() => repository.mutateStorage({ operation:'addRecord', key:'annotations', record:{ id:'a' } })),
    repository.enqueueStorageMutation(() => repository.mutateStorage({ operation:'addRecord', key:'annotations', record:{ id:'b' } }))
  ]);
  assert.deepEqual(data.annotations.map((record) => record.id), ['a', 'b']);
});

test('merges concurrent saves of the same vocabulary lemma', async () => {
  const { data, repository } = repositoryHarness();
  const record = (id, documentId) => ({ id, lemma:'leaf', documentId, context:documentId, anchor:{ exact:'leaf', position:0 } });
  await Promise.all([
    repository.enqueueStorageMutation(() => repository.mutateStorage({ operation:'saveVocabulary', record:record('one', 'web:one') })),
    repository.enqueueStorageMutation(() => repository.mutateStorage({ operation:'saveVocabulary', record:record('two', 'web:two') }))
  ]);
  assert.equal(data.vocabulary.length, 1);
  assert.equal(data.vocabulary[0].occurrences, 2);
  assert.deepEqual([...data.vocabulary[0].documentIds], ['web:one', 'web:two']);
  assert.deepEqual(Object.keys(data.vocabulary[0].anchors).sort(), ['web:one', 'web:two']);
});

test('links a repeated vocabulary word to its latest dictionary conversation', async () => {
  const { data, repository } = repositoryHarness();
  await repository.enqueueStorageMutation(() => repository.mutateStorage({ operation:'saveVocabulary', record:{ id:'first', lemma:'leaf', documentId:'web:one', context:'one', anchor:{ exact:'leaf', position:0 } } }));
  await repository.enqueueStorageMutation(() => repository.mutateStorage({ operation:'saveVocabulary', record:{ id:'second', lemma:'leaf', documentId:'web:two', context:'two', anchor:{ exact:'leaf', position:0 }, conversationId:'dictionary-2', presentation:'dictionary' } }));
  assert.equal(data.vocabulary.length, 1);
  assert.equal(data.vocabulary[0].conversationId, 'dictionary-2');
  assert.equal(data.vocabulary[0].presentation, 'dictionary');
});
