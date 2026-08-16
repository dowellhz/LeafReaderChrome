import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(relativePath) {
  await stat(path.join(root, relativePath));
}

test("manifest content-script modules exist in their declared order", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.deepEqual(scripts, [
    "content-core.js",
    "content-storage.js",
    "content-actions.js",
    "content-markers.js",
    "content.js",
  ]);
  await Promise.all(scripts.map(exists));
});

test("source modules stay within the project line limit", async () => {
  const files = [
    "ai-client.js",
    "background.js",
    "content-actions.js",
    "content-core.js",
    "content-markers.js",
    "content-storage.js",
    "library-store.js",
    "panel-markdown.js",
    "panel-store.js",
    "sidepanel.js",
    "reader-core.js",
    "reader-library.js",
    "reader-document.js",
    "reader-selection.js",
    "reader-tts.js",
    "reader.js",
  ];
  const sources = await Promise.all(
    files.map(async (file) => (await readFile(path.join(root, file), "utf8")).split("\n")),
  );
  sources.forEach((lines, index) => {
    assert.ok(lines.length <= 500, `${files[index]} exceeds 500 lines`);
    assert.ok(
      lines.every((line) => line.length <= 500),
      `${files[index]} contains an overlong source line`,
    );
  });
});
