# LeafReader Chrome — Agent Guide

## Scope

`leafreaderchrome` is a Manifest V3 Chrome extension that brings the LeafReader
web-reading workflow to ordinary `http` and `https` webpages. Web pages are in
scope; PDF support is deliberately out of scope.

The product language is Chinese-first, while source identifiers and most UI
fallback strings remain English.

## Architecture

- `manifest.json` — MV3 metadata, content-script registration, permissions,
  native Side Panel entry point, and extension icons.
- `background.js` — service worker; AI provider requests, native Side Panel
  opening, reader-mode creation, and extension message routing.
- `content.js` / `content.css` — webpage integration: selection toolbar,
  original-page markers, annotation anchoring/restoration, and TTS.
- `sidepanel.*` — native Chrome Side Panel. AI interactions are URL-scoped,
  stored locally, and rendered as a scrollable reading trail.
- `reader.*` — standalone reader/library UI for captured webpages.
- `options.*` — provider, model, language, font, and connection-test settings.
- `popup.*` — compact entry point to reader/library/settings.

## Non-negotiable UX rules

1. The right side is Chrome's native Side Panel, never a webpage overlay.
2. Selecting text must show the floating toolbar without preventing ordinary
   webpage text selection.
3. Translation, dictionary lookup, and AI explanation create persistent,
   clickable original-page markers. Do not replace these with DOM wrappers;
   use the CSS Custom Highlight API and the stored text anchors.
4. Clicking a marker opens the native Side Panel and scrolls to that marker's
   response body, not merely the beginning of the thread.
5. AI trails are scoped by the complete `web:<URL>` document id. Never show a
   previous page's trail on a different URL.
6. New result cards target their response body in the side panel; follow-up
   loading and follow-up replies scroll to the bottom. Restoring an old page
   restores its saved scroll position.
7. Dictionary lookup is for words/short phrases. A selection longer than 160
   characters must be routed to complete translation rather than a faux word
   definition.
8. Full translation must request every selected sentence in order, without
   summarizing or omitting content.
9. During a follow-up request, append the user turn and a visible spinner
   immediately; do not leave the panel silently waiting.

## Native Side Panel rules

- `chrome.sidePanel.open()` requires a user gesture. The floating toolbar uses
  `pointerdown`, and the message handler must call
  `chrome.sidePanel.open({ tabId: sender.tab.id })` directly.
- Do not change this to `windowId`: it can lose the content-script gesture in
  Chrome builds used by this project.
- Do not repeatedly disable and enable a tab-specific panel. That previously
  caused `No active side panel for tabId` races. Keep it enabled and only clear
  stale session payloads on navigation.
- Validate a tab id before calling `chrome.tabs.get()` or any tab-targeted API.
  Side-panel messages can arrive after their associated navigation is gone.

## Storage model

- `chrome.storage.local.settings` — AI and UI settings. API keys stay local.
- `annotations` — highlights, notes, translation/dictionary/explanation
  markers, including robust text anchors.
- `vocabulary` — saved words and SRS state.
- `aiConversations` — individual follow-up message history.
- `sidePanelThreads` — URL-scoped result-card trail and scroll position.
- `chrome.storage.session.leafReaderSidePanel` — transient payload for the
  currently requested native Side Panel state.

Do not log, expose, commit, or hard-code API keys. Use mock endpoints or an
isolated throwaway browser profile for AI smoke tests, and clear test secrets
afterwards.

## Original-page markers

- `content.css` owns the `::highlight(...)` rules. Keep these as declaratively
  injected content-script CSS; pages may remove runtime-created `<style>` tags.
- `content.js` maintains `paintedRanges` so Custom Highlight ranges can be
  detected by click location and linked back to their stored record.
- Preserve `createAnchor`, `rangeForAnchor`, and their prefix/suffix matching
  behavior when changing annotation code. Exact text alone is not sufficient
  on repeated prose.

## AI behavior

- Providers supported by `background.js`: OpenAI-compatible endpoints,
  DeepSeek, OpenRouter, Qwen, Groq, SiliconFlow, Anthropic, Gemini, Ollama,
  Azure, and custom OpenAI-compatible endpoints.
- Provider-specific endpoint rewriting is intentional. In particular, do not
  turn Anthropic's `/v1/messages` or Ollama's `/api/chat` into OpenAI routes.
- Parse OpenAI-compatible text from `choices[0].message.content`; also retain
  existing handling for Anthropic, Gemini, and Ollama responses.
- Normal AI output uses 2200 tokens. The explicit full-translation prompt uses
  4000 tokens. If a provider reports a length stop reason, preserve the visible
  warning to the reader.

## Development and verification

After JavaScript changes, run at least:

```sh
node --check background.js
node --check content.js
node --check sidepanel.js
node --check reader.js
node --check options.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

For a functional check:

1. Reload the unpacked extension in `chrome://extensions`.
2. Refresh the target webpage. Reloading an extension does **not** replace the
   content script in already-open pages.
3. Select a word and a paragraph. Verify floating toolbar, native side-panel
   opening, loading spinner, AI result, follow-up, marker painting, and marker
   click-to-response navigation.
4. Navigate away and back. Verify URL-specific trail/scroll restoration and no
   stale content on unrelated pages.
5. Check the service-worker error view for new exceptions.

When browser automation is needed, start an isolated Chrome profile under
`/private/tmp`, never the user's everyday Chrome profile. Delete the exact
temporary profile after the test.

## Change discipline

- Bump `manifest.json` patch version for any user-visible extension change.
- Maintain the LeafReader icon files in `icons/` and keep manifest icon paths
  valid for 16, 32, 48, and 128 pixels.
- Keep UI output compact. Do not repeat the selected word as a separate `YOU`
  bubble for an initial dictionary response.
- Use `apply_patch` for source edits. Preserve unrelated user changes.
