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
  const manifest = JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
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

test("classic extension pages preserve their explicit dependency order", async () => {
  const pages = {
    "reader.html": [
      "library-store.js",
      "reader-core.js",
      "reader-library.js",
      "reader-document.js",
      "reader-selection.js",
      "reader-tts.js",
      "reader.js",
    ],
    "options.html": [
      "library-store.js",
      "panel-store.js",
      "backup-schema.js",
      "options.js",
    ],
    "sidepanel.html": [
      "panel-store.js",
      "panel-markdown.js",
      "panel-payload.js",
      "sidepanel.js",
    ],
  };
  await Promise.all(
    Object.entries(pages).map(async ([page, scripts]) => {
      const html = await readFile(path.join(root, page), "utf8");
      let prior = -1;
      scripts.forEach((script) => {
        const position = html.indexOf(`src=\"${script}\"`);
        assert.ok(position > prior, `${page} must load ${script} in order`);
        prior = position;
      });
    }),
  );
});

test("options loads the shared theme before settings-specific CSS", async () => {
  const html = await readFile(path.join(root, "options.html"), "utf8");
  assert.ok(
    html.indexOf('href="reader-base.css"') < html.indexOf('href="options.css"'),
    "options must load reader-base.css before options.css",
  );
});

test("side panel scrolls its actual overflow container", async () => {
  const source = await readFile(path.join(root, "sidepanel.js"), "utf8");
  assert.match(
    source,
    /scrollThreadTargetToTop\(\s*content,\s*active\.conversationId/,
  );
  assert.match(
    source,
    /persistThreadScroll\(thread\.documentId, content\.scrollTop\)/,
  );
  assert.match(source, /target\.scrollIntoView/);
});

test("side panel keeps the follow-up composer fixed at the bottom", async () => {
  const css = await readFile(path.join(root, "sidepanel.css"), "utf8");
  const html = await readFile(path.join(root, "sidepanel.html"), "utf8");
  const source = await readFile(path.join(root, "sidepanel.js"), "utf8");
  assert.match(css, /\.composer\s*\{[\s\S]*position:\s*sticky/);
  assert.match(css, /\.composer\s*\{[\s\S]*bottom:\s*0/);
  assert.doesNotMatch(html, /<footer/);
  assert.match(source, /function conversationToolsMarkup\(\)/);
  assert.match(
    source,
    /function followUpMarkup\(\)\s*\{\s*return `<div class="composer"><form/,
  );
  assert.doesNotMatch(
    source.match(/function followUpMarkup\(\)[\s\S]*?\n\}/)?.[0] || "",
    /conversation-tools/,
  );
});

test("side panel listens for session payload updates via chrome.storage", async () => {
  const source = await readFile(path.join(root, "sidepanel.js"), "utf8");
  assert.match(source, /chrome\.storage\.onChanged\.addListener/);
  assert.match(source, /area !== "session"/);
  assert.doesNotMatch(source, /chrome\.storage\.session\.onChanged/);
});

test("source modules stay within the project line limit", async () => {
  const files = [
    "ai-client.js",
    "ai-providers.js",
    "backup-schema.js",
    "background.js",
    "content-actions.js",
    "content-core.js",
    "content.js",
    "content-markers.js",
    "content-storage.js",
    "library-store.js",
    "panel-markdown.js",
    "panel-payload.js",
    "panel-store.js",
    "popup.js",
    "sidepanel.js",
    "reader-core.js",
    "reader-library.js",
    "reader-document.js",
    "reader-selection.js",
    "reader-tts.js",
    "reader.js",
    "record-store.js",
    "scripts/chrome-smoke.mjs",
  ];
  const sources = await Promise.all(
    files.map(async (file) =>
      (await readFile(path.join(root, file), "utf8")).split("\n"),
    ),
  );
  sources.forEach((lines, index) => {
    assert.ok(lines.length <= 500, `${files[index]} exceeds 500 lines`);
    assert.ok(
      lines.every((line) => line.length <= 500),
      `${files[index]} contains an overlong source line`,
    );
  });
});
