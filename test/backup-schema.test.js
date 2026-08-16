import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function validator() {
  const source = await readFile(path.join(root, "backup-schema.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context);
  return context.window.LeafReaderBackup.validateBackup;
}

test("normalizes version 1 backups into the current backup schema", async () => {
  const validateBackup = await validator();
  const backup = validateBackup({
    format: "leafreaderchrome-backup",
    version: 1,
    documents: [],
    annotations: [],
    vocabulary: [],
    conversations: { "conversation:one": { messages: [] } },
    threads: { "thread:web:https://example.test": { entries: [] } },
  });
  assert.equal(backup.version, 2);
  assert.deepEqual(Object.keys(backup.aiConversations), ["conversation:one"]);
  assert.deepEqual(Object.keys(backup.sidePanelThreads), [
    "thread:web:https://example.test",
  ]);
});

test("rejects oversized or malformed backups before restoring data", async () => {
  const validateBackup = await validator();
  assert.throws(() => validateBackup({}, 0), /not a LeafReader/);
  assert.throws(
    () =>
      validateBackup(
        {
          format: "leafreaderchrome-backup",
          version: 2,
          documents: [],
          annotations: [],
          vocabulary: [],
        },
        50 * 1024 * 1024 + 1,
      ),
    /larger than 50 MB/,
  );
});
