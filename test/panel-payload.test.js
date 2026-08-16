import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("recognizes only active URL-scoped thread payloads", async () => {
  const source = await readFile(path.join(root, "panel-payload.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const { isThreadPayload } = context.window.LeafReaderPanelPayload;
  assert.equal(
    isThreadPayload({
      documentId: "web:https://example.test",
      conversationId: "one",
    }),
    true,
  );
  assert.equal(
    isThreadPayload({ documentId: "web:https://example.test" }),
    false,
  );
  assert.equal(
    isThreadPayload({
      documentId: "web:https://example.test",
      conversationId: "one",
      conversationCleared: true,
    }),
    false,
  );
});
