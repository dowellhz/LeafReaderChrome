/* LeafReader Chrome: offline-first reading data lives in IndexedDB; annotations stay in extension storage. */
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let db;
let activeDocument = null;
let annotations = [];
let vocabulary = [];
let settings = { language: "auto", font: "serif" };
let selected = null;
let pendingNote = null;
let searchHits = [];
let matchIndex = -1;
let speaking = false;
let utterance = null;
let ttsQueue = [];
let ttsIndex = 0;
let ttsPaused = false;
let availableVoices = [];
let activeTtsHighlight = null;
let activeSources = [];
let ttsForDocument = false;

function openDatabase() {
  return window.LeafReaderLibraryStore.open();
}
function store(name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
}
function dbGet(id) {
  return new Promise((resolve, reject) => {
    const req = store("documents").get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function dbAll() {
  return new Promise((resolve, reject) => {
    const req = store("documents").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function dbPut(doc) {
  return new Promise((resolve, reject) => {
    const req = store("documents", "readwrite").put(doc);
    req.onsuccess = () => resolve(doc);
    req.onerror = () => reject(req.error);
  });
}
function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const req = store("documents", "readwrite").delete(id);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}
const escapeHtml = (s) =>
  String(s || "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const cleanText = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim();
const makeId = (kind) => `${kind}:${crypto.randomUUID()}`;
const relativeDate = (ms) => {
  const days = Math.floor((Date.now() - ms) / 86400000);
  return !days ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`;
};
const annotationLabel = (kind) =>
  ({
    highlight: "Highlight",
    note: "Note",
    translation: "Translation",
    dictionary: "Dictionary",
    explanation: "AI explanation",
  })[kind] || "Highlight";
const lemmaFor = (value) => {
  const word = cleanText(value)
    .toLocaleLowerCase()
    .replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, "");
  if (!/^[a-z][a-z'-]*$/i.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5)
    return word.slice(0, -3).replace(/([b-df-hj-np-tv-z])\1$/, "$1");
  if (word.endsWith("ed") && word.length > 4)
    return word.slice(0, -2).replace(/([b-df-hj-np-tv-z])\1$/, "$1");
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 3 && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
};

async function loadState() {
  db = await openDatabase();
  const data = await chrome.storage.local.get([
    "annotations",
    "vocabulary",
    "settings",
  ]);
  annotations = data.annotations || [];
  vocabulary = data.vocabulary || [];
  let vocabularyMigrated = false;
  vocabulary.forEach((item) => {
    if (!item.lemma) {
      item.lemma = lemmaFor(item.word);
      vocabularyMigrated = true;
    }
    if (!item.status) {
      item.status = "new";
      vocabularyMigrated = true;
    }
    if (!Number.isFinite(item.dueAt)) {
      item.dueAt = item.createdAt || Date.now();
      vocabularyMigrated = true;
    }
    if (!Number.isFinite(item.intervalDays)) {
      item.intervalDays = 0;
      vocabularyMigrated = true;
    }
    if (!Number.isFinite(item.reviewCount)) {
      item.reviewCount = 0;
      vocabularyMigrated = true;
    }
    if (!Number.isFinite(item.correctCount)) {
      item.correctCount = 0;
      vocabularyMigrated = true;
    }
  });
  if (vocabularyMigrated) await chrome.storage.local.set({ vocabulary });
  settings = { ...settings, ...(data.settings || {}) };
  document.documentElement.dataset.font = settings.font;
  const session = await chrome.storage.session.get([
    "pendingArticle",
    "pendingError",
  ]);
  if (session.pendingArticle) {
    const previous = await dbGet(session.pendingArticle.id);
    await dbPut({
      ...previous,
      ...session.pendingArticle,
      createdAt: previous?.createdAt || Date.now(),
      lastOpenedAt: Date.now(),
      progress: previous?.progress || 0,
    });
    await chrome.storage.session.remove("pendingArticle");
    await openDocument(session.pendingArticle.id);
  } else if (session.pendingError) {
    await chrome.storage.session.remove("pendingError");
    showToast(session.pendingError);
    showView("library");
  } else showView("library");
  await refreshLibrary();
}
async function persistRecords() {
  await chrome.storage.local.set({ annotations, vocabulary });
}
function showView(name) {
  $$(".view").forEach((view) =>
    view.classList.toggle("active", view.id === `${name}View`),
  );
  $$(".nav[data-view]").forEach((button) =>
    button.classList.toggle("active", button.dataset.view === name),
  );
  if (name !== "reader") activeDocument = activeDocument;
}
function showToast(message) {
  $("#assistantTitle").textContent = "LeafReader";
  $("#assistantResult").textContent = message;
  $("#assistantPanel").hidden = false;
  setTimeout(() => {
    if ($("#assistantResult").textContent === message)
      $("#assistantPanel").hidden = true;
  }, 3600);
}
