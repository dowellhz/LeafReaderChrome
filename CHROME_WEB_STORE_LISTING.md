# Chrome Web Store listing draft

## Short description

AI-assisted focused reading for any webpage: translation, offline dictionary,
vocabulary review, notes, read-aloud, and source-aware Q&A.

## Detailed description

LeafReader Chrome turns everyday webpages into a calmer reading workspace.
Select a word, phrase, sentence, or paragraph to translate it, look it up,
listen to it, save a note, or ask for a clear explanation.

### Read with less friction

- **Translation and explanation** — translate selected text or get a structured
  explanation of a difficult sentence.
- **Offline dictionary** — look up common English words locally, with no
  network request for the dictionary itself.
- **Read aloud** — listen to selected text using voices available in Chrome.
- **Vocabulary review** — saved words are collected in one personal word list
  with simple spaced review controls.
- **Notes and markers** — save useful passages and jump back to their original
  location on the webpage.
- **Reader mode and search** — capture a webpage for focused reading, search
  the saved text, and ask questions with matching source passages included.

### Your data stays under your control

Reading data, notes, vocabulary, and settings are stored locally in your
browser. LeafReader Chrome has no account system and does not operate a
backend that receives your reading history. AI requests are made only when you
choose an AI action, using the provider and API key you configure in Settings.

LeafReader Chrome is designed for ordinary HTTP and HTTPS webpages. It does
not support PDF reading.

## Single purpose

Help readers understand, annotate, and revisit ordinary webpages.

## Permission justification

- `storage` and `unlimitedStorage`: save the local reading library, notes,
  vocabulary, AI trails, and the bundled offline dictionary index.
- `activeTab`, `scripting`, and HTTP/HTTPS host access: add the selection
  toolbar and original-page markers only on webpages the reader opens.
- `tabs`: open the reader view and associate a Side Panel response with its
  source tab.
- `sidePanel`: show selected-text results in Chrome's native Side Panel.

## Required store assets before submission

1. 1280×800 screenshots: selection toolbar, Side Panel, offline dictionary,
   vocabulary review, and reader mode.
2. A 1400×560 top promotional tile, a 440×280 promotional tile, and a
   128×128 store icon.
3. A hosted copy of `PRIVACY.md` and a support contact.
