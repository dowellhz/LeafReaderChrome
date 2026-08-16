const paintRange = (record, range) => {
  if (!range || !window.CSS?.highlights || !window.Highlight) return;
  const name =
    {
      note: "leafreader-page-note",
      word: "leafreader-page-word",
      translation: "leafreader-page-translation",
      dictionary: "leafreader-page-dictionary",
      explanation: "leafreader-page-explanation",
    }[record.kind] || "leafreader-page-highlight";
  const set = highlightSets.get(name) || new Highlight();
  set.add(range);
  highlightSets.set(name, set);
  window.CSS.highlights.set(name, set);
  paintedRanges.push({ record, range });
};
const paintRecord = (record, index) => {
  if (record?.documentId === documentId)
    paintRange(record, rangeForAnchor(record.anchor, index));
};
let restoringRecords = false;
let restoreRequested = false;
const restoreRecords = async () => {
  if (!extensionContextIsAlive()) return;
  if (restoringRecords) {
    restoreRequested = true;
    return;
  }
  restoringRecords = true;
  restoreRequested = false;
  try {
    const { annotations = [], vocabulary = [] } =
      await chrome.storage.local.get(["annotations", "vocabulary"]);
    const records = [...annotations, ...vocabulary].filter(
      (record) => record.documentId === documentId,
    );
    const index = records.length ? textIndex() : null;
    for (const name of highlightSets.keys())
      window.CSS?.highlights?.delete(name);
    highlightSets.clear();
    paintedRanges = [];
    if (index) records.forEach((record) => paintRecord(record, index));
  } finally {
    restoringRecords = false;
    if (restoreRequested) void restoreRecords();
  }
};
const display = (title, body, quote = "", extra = {}) =>
  sendToExtension({
    type: "OPEN_LEAF_SIDEPANEL",
    payload: {
      mode: "result",
      title,
      body,
      quote,
      documentId,
      documentTitle,
      context: selectedContext,
      ...extra,
    },
  });
const clearSelection = () => {
  window.getSelection()?.removeAllRanges();
  toolbar.hidden = true;
};
const save = async (key, value) =>
  localStorageCall(async () => {
    const current = (await chrome.storage.local.get(key))[key] || [];
    current.push(value);
    await chrome.storage.local.set({ [key]: current });
  });
const saveWord = async () =>
  localStorageCall(async () => {
    const { vocabulary = [] } = await chrome.storage.local.get("vocabulary");
    const lemma = lemmaFor(selectedText);
    const now = Date.now();
    const existing = vocabulary.find((item) => item.lemma === lemma);
    if (existing) {
      existing.occurrences = Number(existing.occurrences || 1) + 1;
      existing.lastSeenAt = now;
      existing.updatedAt = now;
      existing.documentIds = [
        ...new Set([
          ...(existing.documentIds || [existing.documentId].filter(Boolean)),
          documentId,
        ]),
      ];
      existing.contexts = [
        ...(existing.contexts || [existing.context].filter(Boolean)),
        selectedContext,
      ]
        .filter(Boolean)
        .slice(-5);
      await chrome.storage.local.set({ vocabulary });
      return { record: existing, created: false };
    }
    const record = createRecord("word", {
      word: selectedText.slice(0, 160),
      lemma,
      definition: "",
      occurrences: 1,
      documentIds: [documentId],
      contexts: [selectedContext],
      status: "new",
      intervalDays: 0,
      dueAt: now,
      reviewCount: 0,
      correctCount: 0,
      lastSeenAt: now,
    });
    vocabulary.push(record);
    await chrome.storage.local.set({ vocabulary });
    return { record, created: true };
  });
const saveDefinition = async (word, definition) =>
  localStorageCall(async () => {
    const { vocabulary = [] } = await chrome.storage.local.get("vocabulary");
    const item = vocabulary.find(
      (candidate) => candidate.lemma === lemmaFor(word),
    );
    if (!item) return;
    item.definition = definition;
    item.updatedAt = Date.now();
    await chrome.storage.local.set({ vocabulary });
  });
const createRecord = (kind, extras = {}) => ({
  id: `${kind}:${crypto.randomUUID()}`,
  documentId,
  documentTitle,
  quote: selectedText,
  context: selectedContext,
  anchor: createAnchor(selectedRange),
  kind,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  favorite: false,
  ...extras,
});
