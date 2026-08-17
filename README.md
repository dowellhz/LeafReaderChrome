# LeafReader Chrome

A Manifest V3 Chrome extension inspired by Leaf Reader’s focused reading workflow.

## Included

- Extract a current webpage into a calm reading view
- Select text on any webpage for an in-page LeafReader floating menu and right-side assistant panel
- Local library with reading progress
- Text search, typography controls, light/dark themes, and sentence-by-sentence browser read-aloud
- Persistent webpage highlights/notes with refresh recovery, Markdown/JSON export, and backup/restore
- Personal vocabulary with lemma grouping, review scheduling, and offline lookup from LeafReader's trimmed ECDICT index
- Optional multi-provider AI for translation, explanations, source-aware webpage Q&A, and exportable follow-up conversations

## Install locally

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this `leafreaderchrome` directory.
4. Open any article and click the LeafReader toolbar button.

Captured webpages are stored in the browser’s IndexedDB. Notes, vocabulary, and settings are stored in Chrome extension local storage. The optional AI capability sends text only after you configure a provider in Settings. PDF, EPUB, and DOCX are intentionally outside this extension’s scope.

## Development checks

The shared TTS language, chunking, voice-selection, normalization, and playback-state logic has dependency-free Node tests:

```sh
npm test
```

For release verification, run `npm run verify`. See `PRIVACY.md`,
`CHROME_WEB_STORE_LISTING.md`, and `RELEASE_CHECKLIST.md` for store materials.
