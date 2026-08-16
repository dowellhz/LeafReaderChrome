/* Shared annotation and vocabulary mutations live in the service worker.
 * Extension pages and content scripts must never compete with whole-array
 * read/modify/write calls in chrome.storage.local. */
let recordQueue = Promise.resolve();
const collections = new Set(["annotations", "vocabulary"]);

const timestamp = (record) =>
  Number(record?.updatedAt || record?.createdAt || 0);

function mutateCollection(key, update) {
  if (!collections.has(key)) {
    throw new Error(`Unsupported record collection: ${key}`);
  }
  const task = recordQueue.then(async () => {
    const { [key]: current = [] } = await chrome.storage.local.get(key);
    const records = structuredClone(current);
    const result = await update(records);
    await chrome.storage.local.set({ [key]: records });
    return result;
  });
  recordQueue = task.catch(() => undefined);
  return task;
}

export function upsertRecord(collection, record) {
  if (!record?.id) throw new Error("A record id is required.");
  return mutateCollection(collection, (records) => {
    const index = records.findIndex((item) => item.id === record.id);
    if (index < 0) records.push(record);
    else if (timestamp(record) >= timestamp(records[index])) {
      records[index] = { ...records[index], ...record };
    }
    return records.find((item) => item.id === record.id) || record;
  });
}

export function deleteRecord(collection, id) {
  return mutateCollection(collection, (records) => {
    const index = records.findIndex((item) => item.id === id);
    if (index >= 0) records.splice(index, 1);
  });
}

export function saveMarker(record) {
  return mutateCollection("annotations", (records) => {
    const match = records.find(
      (item) =>
        item.kind === record.kind &&
        item.documentId === record.documentId &&
        item.anchor?.position === record.anchor?.position &&
        item.anchor?.exact === record.anchor?.exact,
    );
    if (match) {
      Object.assign(match, record, { id: match.id, updatedAt: Date.now() });
      return match;
    }
    records.push(record);
    return record;
  });
}

export function saveVocabularyOccurrence(seed) {
  return mutateCollection("vocabulary", (records) => {
    const existing = records.find((item) => item.lemma === seed.lemma);
    if (!existing) {
      records.push(seed);
      return { record: seed, created: true };
    }
    const now = Date.now();
    existing.occurrences = Number(existing.occurrences || 1) + 1;
    existing.lastSeenAt = now;
    existing.updatedAt = now;
    existing.documentIds = [
      ...new Set([...(existing.documentIds || []), seed.documentId]),
    ];
    existing.contexts = [...(existing.contexts || []), seed.context]
      .filter(Boolean)
      .slice(-5);
    return { record: existing, created: false };
  });
}

export function saveVocabularyDefinition(lemma, definition) {
  return mutateCollection("vocabulary", (records) => {
    const record = records.find((item) => item.lemma === lemma);
    if (!record) return null;
    record.definition = definition;
    record.updatedAt = Date.now();
    return record;
  });
}

export async function syncReaderRecords({ annotations = [], vocabulary = [] }) {
  const merge = async (collection, incoming) =>
    mutateCollection(collection, (records) => {
      incoming.forEach((record) => {
        const index = records.findIndex((item) => item.id === record.id);
        if (index < 0) records.push(record);
        else if (timestamp(record) >= timestamp(records[index])) {
          records[index] = { ...records[index], ...record };
        }
      });
      return records;
    });
  const [nextAnnotations, nextVocabulary] = await Promise.all([
    merge("annotations", annotations),
    merge("vocabulary", vocabulary),
  ]);
  return { annotations: nextAnnotations, vocabulary: nextVocabulary };
}
