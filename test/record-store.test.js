import assert from "node:assert/strict";
import test from "node:test";

function storageMock() {
  const data = {};
  return {
    data,
    local: {
      async get(key) {
        if (Array.isArray(key))
          return Object.fromEntries(key.map((item) => [item, data[item]]));
        return { [key]: data[key] };
      },
      async set(values) {
        Object.assign(data, structuredClone(values));
      },
    },
  };
}

test("serializes marker writes without dropping either record", async () => {
  const storage = storageMock();
  globalThis.chrome = { storage };
  const { saveMarker } = await import(`../record-store.js?test=${Date.now()}`);
  const first = saveMarker({
    id: "one",
    kind: "translation",
    documentId: "web:https://example.test",
    anchor: { exact: "first", position: 1 },
  });
  const second = saveMarker({
    id: "two",
    kind: "explanation",
    documentId: "web:https://example.test",
    anchor: { exact: "second", position: 10 },
  });
  await Promise.all([first, second]);
  assert.deepEqual(
    storage.data.annotations.map((record) => record.id),
    ["one", "two"],
  );
  delete globalThis.chrome;
});

test("repairs a malformed legacy collection before saving a marker", async () => {
  const storage = storageMock();
  storage.data.annotations = { legacy: true };
  globalThis.chrome = { storage };
  const { saveMarker } = await import(`../record-store.js?test=${Date.now()}`);
  const record = await saveMarker({
    id: "repaired",
    kind: "translation",
    documentId: "web:https://example.test",
    anchor: { exact: "text", position: 1 },
  });
  assert.equal(record.id, "repaired");
  assert.deepEqual(
    storage.data.annotations.map((item) => item.id),
    ["repaired"],
  );
  delete globalThis.chrome;
});
