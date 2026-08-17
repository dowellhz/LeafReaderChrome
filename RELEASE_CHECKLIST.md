# Release checklist

1. Run `npm run verify`.
2. Reload the unpacked extension and refresh an existing webpage.
3. Verify translation, offline word lookup, difficult-sentence analysis,
   follow-up, marker click-to-response, and on-page read-aloud.
4. Verify a page navigation restores only that URL's Side Panel trail.
5. Open reader mode and verify search, source citations, vocabulary review,
   note expansion, and backup/restore.
6. Confirm no API key appears in source, screenshots, backup, logs, or Git.
7. Build the upload ZIP from the repository contents excluding `.git`, test
   fixtures, and local development metadata; then submit it with the assets
   and privacy-policy URL listed in `CHROME_WEB_STORE_LISTING.md`.
