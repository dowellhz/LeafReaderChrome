/* LeafReader Chrome: offline-first reading data lives in IndexedDB; annotations stay in extension storage. */
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const DB_NAME = 'leafreaderchrome';
let db;
let activeDocument = null;
let annotations = [];
let vocabulary = [];
let settings = { language: 'auto', font: 'serif' };
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
let activeSearchIndex = null;
let ttsForDocument = false;
let ttsGeneration = 0;
let ttsPreferences = { voices: {}, rate: 1, pitch: 1, localOnly: true };
let voicesLoadingPromise = null;
let readerTextIndex = null;
const readerHighlightSets = new Map();
let readerPaintedRanges = [];
let documentSaveTimer = 0;
let documentStateDirty = false;
let documentWriteQueue = Promise.resolve();
const preferredTtsLanguage = LeafTts.preferredLanguage;
const ttsLanguageKey = LeafTts.languageKey;
const speechChunks = LeafTts.chunkText;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('documents', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function store(name, mode = 'readonly') { return db.transaction(name, mode).objectStore(name); }
function dbGet(id) { return new Promise((resolve, reject) => { const req = store('documents').get(id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
function dbAll() { return new Promise((resolve, reject) => { const req = store('documents').getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
function dbPut(doc) { return new Promise((resolve, reject) => { const transaction = db.transaction('documents', 'readwrite'); transaction.objectStore('documents').put(doc); transaction.oncomplete = () => resolve(doc); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); }
function dbDelete(id) { return new Promise((resolve, reject) => { const transaction = db.transaction('documents', 'readwrite'); transaction.objectStore('documents').delete(id); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); }
async function mutateStorage(mutation) {
  const result = await chrome.runtime.sendMessage({ type:'STORAGE_MUTATION', mutation });
  if (!result?.ok) throw new Error(result?.error || 'LeafReader could not save local data.');
  return result;
}
function acceptRecords(key, result) {
  if (!Array.isArray(result?.records)) return;
  if (key === 'annotations') annotations = result.records;
  if (key === 'vocabulary') vocabulary = result.records;
}
const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const cleanText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const makeId = (kind) => `${kind}:${crypto.randomUUID()}`;
const relativeDate = (ms) => { const days = Math.floor((Date.now() - ms) / 86400000); return !days ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`; };
const annotationLabel = (kind) => ({ highlight: 'Highlight', note: 'Note', translation: 'Translation', dictionary: '单词释义', analysis: '难句分析', explanation: '讲解' }[kind] || 'Highlight');
const lemmaFor = (value) => {
  const word = cleanText(value).toLocaleLowerCase().replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, '');
  if (!/^[a-z][a-z'-]*$/i.test(word)) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3).replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2).replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
};

async function loadState() {
  db = await openDatabase();
  const data = await chrome.storage.local.get(['annotations', 'vocabulary', 'settings', 'ttsPreferences']);
  annotations = data.annotations || [];
  vocabulary = data.vocabulary || [];
  for (const item of [...vocabulary]) {
    const changes = {};
    if (!item.lemma) changes.lemma = lemmaFor(item.word);
    if (!item.status) changes.status = 'new';
    if (!Number.isFinite(item.dueAt)) changes.dueAt = item.createdAt || Date.now();
    if (!Number.isFinite(item.intervalDays)) changes.intervalDays = 0;
    if (!Number.isFinite(item.reviewCount)) changes.reviewCount = 0;
    if (!Number.isFinite(item.correctCount)) changes.correctCount = 0;
    if (Object.keys(changes).length) acceptRecords('vocabulary', await mutateStorage({ operation:'patchRecord', key:'vocabulary', id:item.id, changes }));
  }
  settings = { ...settings, ...(data.settings || {}) };
  ttsPreferences = {
    voices: { ...(data.ttsPreferences?.voices || {}) },
    rate: Number(data.ttsPreferences?.rate || localStorage.getItem('leaf-tts-rate') || 1),
    pitch: Number(data.ttsPreferences?.pitch || 1),
    localOnly: data.ttsPreferences?.localOnly !== false
  };
  const legacyVoiceUri = localStorage.getItem('leaf-tts-voice'); const legacyVoice = availableVoices.find((voice) => voice.voiceURI === legacyVoiceUri);
  if (legacyVoice && !ttsPreferences.voices[ttsLanguageKey(legacyVoice.lang)]) { ttsPreferences.voices[ttsLanguageKey(legacyVoice.lang)] = legacyVoice.voiceURI; localStorage.removeItem('leaf-tts-voice'); }
  await chrome.storage.local.set({ ttsPreferences });
  $('#ttsRate').value = ttsPreferences.rate;
  $('#ttsPitch').value = ttsPreferences.pitch;
  $('#ttsLocalOnly').checked = ttsPreferences.localOnly;
  document.documentElement.dataset.font = settings.font;
  populateVoices();
  const session = await chrome.storage.session.get(['pendingArticle', 'pendingError']);
  if (session.pendingArticle) {
    const previous = await dbGet(session.pendingArticle.id);
    await dbPut({ ...previous, ...session.pendingArticle, createdAt: previous?.createdAt || Date.now(), lastOpenedAt: Date.now(), progress: previous?.progress || 0 });
    await chrome.storage.session.remove('pendingArticle');
    await openDocument(session.pendingArticle.id);
  } else if (session.pendingError) {
    await chrome.storage.session.remove('pendingError');
    showToast(session.pendingError);
    showView('library');
  } else showView('library');
  await refreshLibrary();
}
function showView(name) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `${name}View`));
  $$('.nav[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  if (name !== 'reader') activeDocument = activeDocument;
}
function showToast(message) {
  $('#assistantTitle').textContent = 'LeafReader'; $('#assistantResult').textContent = message; $('#assistantPanel').hidden = false;
  setTimeout(() => { if ($('#assistantResult').textContent === message) $('#assistantPanel').hidden = true; }, 3600);
}

async function refreshLibrary() {
  const docs = await dbAll();
  $('#libraryCount').textContent = `${docs.length} item${docs.length === 1 ? '' : 's'} in library`;
  renderDocuments(docs);
  renderNotes(); renderWords();
}
function renderDocuments(docs) {
  const query = $('#librarySearch').value.toLowerCase();
  const order = $('#sortDocuments').value;
  const sorted = docs.filter((doc) => `${doc.title} ${doc.text}`.toLowerCase().includes(query)).sort((a,b) => order === 'title' ? a.title.localeCompare(b.title) : order === 'progress' ? (b.progress||0)-(a.progress||0) : (b.lastOpenedAt||0)-(a.lastOpenedAt||0));
  $('#documentGrid').innerHTML = sorted.map((doc) => `<button class="book-card" data-document-id="${escapeHtml(doc.id)}"><div class="book-cover">${escapeHtml(doc.title).slice(0,70)}</div><div class="card-body"><strong>${escapeHtml(doc.title)}</strong><small>${escapeHtml(doc.byline || doc.type || 'Web article')} · ${relativeDate(doc.lastOpenedAt || doc.createdAt)}</small><div class="card-progress"><i style="width:${Math.round((doc.progress||0)*100)}%"></i></div></div></button>`).join('');
  $('#emptyLibrary').hidden = sorted.length > 0;
  $('#documentGrid').hidden = !sorted.length;
  $$('#documentGrid [data-document-id]').forEach((button) => button.onclick = () => openDocument(button.dataset.documentId));
}
async function noteResponse(note) {
  const { aiConversations = {}, sidePanelThreads = {} } = await chrome.storage.local.get(['aiConversations', 'sidePanelThreads']);
  const messages = aiConversations[`conversation:${note.conversationId}`]?.messages || [];
  const answer = [...messages].reverse().find((message) => message?.role === 'assistant')?.content;
  if (answer) return answer;
  return sidePanelThreads[`thread:${note.documentId}`]?.entries?.find((entry) => entry.conversationId === note.conversationId)?.body || '';
}
function renderNotes() {
  const latest = [...annotations].sort((a,b) => b.createdAt - a.createdAt);
  $('#notesList').innerHTML = latest.length ? latest.map((note) => `<article class="record"><div class="record-actions"><button title="Delete marker" data-delete-note="${note.id}">×</button><button title="${note.favorite ? 'Remove favorite' : 'Favorite'}" data-favorite-note="${note.id}">${note.favorite ? '★' : '☆'}</button><button title="Edit note" data-edit-note="${note.id}">✎</button>${note.conversationId ? `<button title="展开 AI 内容" data-expand-note="${note.id}">展开</button>` : ''}${note.documentId?.startsWith('web:') ? `<button title="Open webpage" data-open-note="${note.id}">↗</button>` : ''}</div><blockquote>${escapeHtml(note.quote)}</blockquote>${note.note ? `<p>${escapeHtml(note.note)}</p>` : ''}${note.conversationId ? `<section class="note-response" hidden></section>` : ''}<small>${annotationLabel(note.kind)} · ${escapeHtml(note.documentTitle || 'Reading')} · ${relativeDate(note.createdAt)}</small></article>`).join('') : `<div class="empty"><div class="leaf-illustration">✎</div><h2>No markers yet</h2><p>Select text while reading, then choose a reading action.</p></div>`;
  $$('[data-delete-note]').forEach((button) => button.onclick = async () => { acceptRecords('annotations', await mutateStorage({ operation:'removeRecord', key:'annotations', id:button.dataset.deleteNote })); renderNotes(); restoreAnnotations(); });
  $$('[data-favorite-note]').forEach((button) => button.onclick = async () => { acceptRecords('annotations', await mutateStorage({ operation:'toggleFavorite', key:'annotations', id:button.dataset.favoriteNote })); renderNotes(); });
  $$('[data-edit-note]').forEach((button) => button.onclick = () => { const note = annotations.find((item) => item.id === button.dataset.editNote); if (!note) return; pendingNote = { record: note, editing: true }; $('#noteQuote').textContent = note.quote; $('#noteText').value = note.note || ''; $('#noteDialog').showModal(); });
  $$('[data-open-note]').forEach((button) => button.onclick = () => chrome.runtime.sendMessage({ type:'OPEN_DOCUMENT_SOURCE', documentId:annotations.find((item) => item.id === button.dataset.openNote)?.documentId }));
  $$('[data-expand-note]').forEach((button) => button.onclick = async () => {
    const note = annotations.find((item) => item.id === button.dataset.expandNote); const response = button.closest('.record')?.querySelector('.note-response');
    if (!note || !response) return;
    if (!response.hidden) { response.hidden = true; button.textContent = '展开'; return; }
    button.disabled = true;
    try { const answer = await noteResponse(note); response.innerHTML = answer ? renderAssistantMarkdown(answer) : '<p class="muted">未找到这条标记保存的回答。</p>'; response.hidden = false; button.textContent = '收起'; }
    catch (error) { response.innerHTML = `<p class="muted">无法读取回答：${escapeHtml(error.message)}</p>`; response.hidden = false; button.textContent = '重试'; }
    finally { button.disabled = false; }
  });
}
function renderWords() {
  const latest = [...vocabulary].sort((a,b) => (a.dueAt || Infinity) - (b.dueAt || Infinity) || b.createdAt - a.createdAt);
  const due = latest.filter((word) => (word.dueAt || 0) <= Date.now()).length;
  $('#reviewDue').textContent = due ? `Review ${due}` : 'Review due';
  $('#wordsList').innerHTML = latest.length ? latest.map((word) => `<article class="record word-record"><div class="record-actions"><button title="Remove word" data-delete-word="${word.id}">×</button><button title="Look up definition" data-lookup-word="${word.id}">⌕</button><button title="Mark known" data-known-word="${word.id}">✓</button></div><blockquote>${escapeHtml(word.word)}</blockquote>${word.definition ? renderWordDefinition(word.definition) : '<p class="muted">No definition yet — use the search button to look it up.</p>'}<div class="review-actions"><button data-review-word="${word.id}" data-quality="again">Again</button><button data-review-word="${word.id}" data-quality="good">Remember</button></div><small>${escapeHtml(word.status || 'new')} · seen ${word.occurrences || 1}× · reviewed ${word.reviewCount || 0}×${word.dueAt ? ` · ${word.dueAt <= Date.now() ? 'due now' : `next ${new Date(word.dueAt).toLocaleDateString()}`}` : ''}</small></article>`).join('') : `<div class="empty"><div class="leaf-illustration">◎</div><h2>Your vocabulary will grow here</h2><p>Select a word or phrase and save it while reading.</p></div>`;
  $$('[data-delete-word]').forEach((button) => button.onclick = async () => { acceptRecords('vocabulary', await mutateStorage({ operation:'removeRecord', key:'vocabulary', id:button.dataset.deleteWord })); renderWords(); restoreAnnotations(); });
  $$('[data-known-word]').forEach((button) => button.onclick = async () => { acceptRecords('vocabulary', await mutateStorage({ operation:'markVocabularyKnown', id:button.dataset.knownWord })); renderWords(); });
  $$('[data-lookup-word]').forEach((button) => button.onclick = () => { const word = vocabulary.find((item) => item.id === button.dataset.lookupWord); if (word) lookupWord(word.word); });
  $$('[data-review-word]').forEach((button) => button.onclick = async () => { acceptRecords('vocabulary', await mutateStorage({ operation:'reviewVocabulary', id:button.dataset.reviewWord, correct:button.dataset.quality === 'good' })); renderWords(); });
}

function downloadExport(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function notesMarkdown() {
  return [...annotations].sort((a, b) => b.createdAt - a.createdAt).map((note) => `## ${note.documentTitle || 'Reading'}\n\n> ${note.quote || ''}\n\n${note.note || ''}\n\n_${new Date(note.createdAt).toLocaleString()}${note.favorite ? ' · ★ Favorite' : ''}_\n`).join('\n');
}

function sanitizeHtml(html) {
  const template = document.createElement('template'); template.innerHTML = html || '';
  template.content.querySelectorAll('script,style,iframe,object,embed,form,button,nav,aside,footer,header').forEach((node) => node.remove());
  template.content.querySelectorAll('*').forEach((node) => [...node.attributes].forEach((attribute) => { if (/^on/i.test(attribute.name) || attribute.name === 'style') node.removeAttribute(attribute.name); }));
  return template.innerHTML;
}
function renderAssistantMarkdown(value) {
  const inline = (line) => escapeHtml(line).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n'); const output = []; let paragraph = []; let list = null;
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; } };
  const flushList = () => { if (list) { output.push(`<${list.type}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.type}>`); list = null; } };
  for (const line of lines) { const heading = line.match(/^(#{1,3})\s+(.+)$/); const bullet = line.match(/^\s*[-*+]\s+(.+)$/); const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/); if (heading) { flushParagraph(); flushList(); output.push(`<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`); } else if (bullet || ordered) { flushParagraph(); const type = ordered ? 'ol' : 'ul'; if (!list || list.type !== type) { flushList(); list = { type, items:[] }; } list.items.push((bullet || ordered)[1]); } else if (!line.trim()) { flushParagraph(); flushList(); } else { flushList(); paragraph.push(line); } }
  flushParagraph(); flushList(); return output.join('') || '<p></p>';
}
function renderWordDefinition(value) { return `<div class="word-definition">${renderAssistantMarkdown(value)}</div>`; }
function setAssistantResult(value, markdown = true) {
  const panel = $('#assistantResult'); panel.innerHTML = markdown ? renderAssistantMarkdown(value).replace(/\[S(\d+)\]/g, '<button class="source-cite" data-source="$1">[S$1]</button>') : `<p>${escapeHtml(value)}</p>`;
  panel.querySelectorAll('[data-source]').forEach((button) => button.onclick = () => { const source = activeSources[Number(button.dataset.source) - 1]; if (!source) return; const range = rangeForQuote(source.slice(0, 220)); if (!range) { showToast('This source could not be located in the current webpage.'); return; } if (window.CSS?.highlights && window.Highlight) window.CSS.highlights.set('leafreader-source', new Highlight(range)); range.startContainer.parentElement?.scrollIntoView({ block:'center', behavior:'smooth' }); });
}

async function openDocument(id) {
  stopSpeaking();
  await flushDocumentState();
  const doc = await dbGet(id); if (!doc) return;
  activeDocument = { ...doc, lastOpenedAt: Date.now() }; await dbPut(activeDocument);
  $('#readerTitle').textContent = doc.title; $('#readerMeta').textContent = doc.byline || doc.sourceUrl || doc.type || '';
  showView('reader');
  $('#article').style.setProperty('--text-size', `${localStorage.getItem('leaf-font-size') || 18}px`);
  $('#article').style.setProperty('--text-width', `${localStorage.getItem('leaf-text-width') || 720}px`);
  $('#article').style.setProperty('--leading', localStorage.getItem('leaf-leading') || 1.8);
  $('#fontSize').value = localStorage.getItem('leaf-font-size') || 18; $('#textWidth').value = localStorage.getItem('leaf-text-width') || 720; $('#lineHeight').value = localStorage.getItem('leaf-leading') || 1.8;
  $('#article').innerHTML = sanitizeHtml(doc.html || `<p>${escapeHtml(doc.text)}</p>`);
  activeSearchIndex = LeafSearch.build(doc.text || $('#article').innerText);
  readerTextIndex = null;
  populateVoices();
  restoreAnnotations();
  window.scrollTo({ top: Math.max(0, (doc.progress || 0) * Math.max(0, document.documentElement.scrollHeight - innerHeight)), behavior: 'instant' });
}
function scheduleDocumentSave(delay = 750) {
  if (!activeDocument) return;
  documentStateDirty = true;
  clearTimeout(documentSaveTimer);
  documentSaveTimer = setTimeout(() => { void flushDocumentState(); }, delay);
}
async function flushDocumentState() {
  clearTimeout(documentSaveTimer);
  if (!documentStateDirty || !activeDocument || !db) return;
  documentStateDirty = false;
  const snapshot = { ...activeDocument };
  documentWriteQueue = documentWriteQueue.then(() => dbPut(snapshot), () => dbPut(snapshot));
  await documentWriteQueue;
}
function saveProgress() {
  if (!activeDocument || !$('#readerView').classList.contains('active')) return;
  const total = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  activeDocument.progress = Math.min(1, Math.max(0, scrollY / total)); activeDocument.lastOpenedAt = Date.now();
  $('#progressBar').style.width = `${activeDocument.progress * 100}%`;
  scheduleDocumentSave();
}
let scrollTick = 0;
addEventListener('scroll', () => { cancelAnimationFrame(scrollTick); scrollTick = requestAnimationFrame(saveProgress); }, { passive: true });
addEventListener('pagehide', () => { saveProgress(); void flushDocumentState(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { saveProgress(); void flushDocumentState(); } });

function getReaderTextIndex() {
  if (!readerTextIndex) readerTextIndex = LeafAnchor.buildTextIndex($('#article'), 'script,style,noscript');
  return readerTextIndex;
}
function rangeForQuote(quote, occurrence = 0) {
  const exact = cleanText(quote);
  if (!exact) return null;
  const index = getReaderTextIndex();
  let position = -1;
  let cursor = 0;
  for (let count = 0; count <= occurrence; count += 1) {
    position = index.text.toLocaleLowerCase().indexOf(exact.toLocaleLowerCase(), cursor);
    if (position < 0) return null;
    cursor = position + exact.length;
  }
  return LeafAnchor.rangeForAnchor({ exact, position }, index, document);
}
function readerRangeForRecord(record) {
  const anchor = record?.anchors?.[activeDocument?.id] || record?.anchor || {
    exact:record?.quote || record?.word,
    position:Number(record?.locator?.position || 0)
  };
  return LeafAnchor.rangeForAnchor(anchor, getReaderTextIndex(), document);
}
function paintReaderRange(record, range) {
  if (!range || !window.CSS?.highlights || !window.Highlight) return;
  const name = ({ note:'leafreader-reader-note', word:'leafreader-reader-word', translation:'leafreader-reader-translation', dictionary:'leafreader-reader-dictionary', analysis:'leafreader-reader-analysis', explanation:'leafreader-reader-explanation' }[record.kind] || 'leafreader-reader-highlight');
  const highlight = readerHighlightSets.get(name) || new Highlight();
  highlight.add(range);
  readerHighlightSets.set(name, highlight);
  window.CSS.highlights.set(name, highlight);
  readerPaintedRanges.push({ record, range });
}
function restoreAnnotations() {
  for (const name of readerHighlightSets.keys()) window.CSS?.highlights?.delete(name);
  readerHighlightSets.clear();
  readerPaintedRanges = [];
  if (!activeDocument) return;
  const belongs = (item) => item.documentId === activeDocument.id || item.documentIds?.includes(activeDocument.id);
  [...annotations, ...vocabulary].filter(belongs).sort((a,b) => b.createdAt - a.createdAt).forEach((item) => paintReaderRange(item, readerRangeForRecord(item)));
}
function selectionChanged() {
  const current = getSelection(); const text = cleanText(current?.toString()); const range = current?.rangeCount ? current.getRangeAt(0) : null;
  if (!text || !range || !$('#article').contains(range.commonAncestorContainer)) { $('#selectionToolbar').hidden = true; selected = null; return; }
  selected = { text, range:range.cloneRange(), context:cleanText(range.commonAncestorContainer.parentElement?.innerText).slice(0, 450), anchor:LeafAnchor.createAnchor(range, getReaderTextIndex()) };
  const rect = range.getBoundingClientRect(); const bar = $('#selectionToolbar'); bar.hidden = false; bar.style.left = `${Math.max(8, Math.min(innerWidth - 260, rect.left + rect.width / 2 - 110))}px`; bar.style.top = `${Math.max(8, rect.top - 46)}px`;
}
document.addEventListener('selectionchange', () => requestAnimationFrame(selectionChanged));
function clearSelection() { getSelection()?.removeAllRanges(); $('#selectionToolbar').hidden = true; selected = null; }
async function addWord() {
  if (!selected || !activeDocument) return;
  if (selected.text.length > 160) { await aiAction('translate'); return; }
  const word = selected.text.slice(0, 160); const lemma = lemmaFor(word); const record = { id:makeId('word'), documentId:activeDocument.id, documentTitle:activeDocument.title, word, lemma, context:selected.context, contexts:[selected.context], documentIds:[activeDocument.id], anchor:selected.anchor, anchors:{ [activeDocument.id]:selected.anchor }, definition:'', occurrences:1, status:'new', intervalDays:0, dueAt:Date.now(), reviewCount:0, correctCount:0, createdAt:Date.now(), updatedAt:Date.now() };
  const result = await mutateStorage({ operation:'saveVocabulary', record }); acceptRecords('vocabulary', result); restoreAnnotations();
  if (!result.created) showToast(`Vocabulary updated: seen ${result.record.occurrences} times.`);
  clearSelection(); await lookupWord(word);
}
function openNote() { if (!selected) return; pendingNote = { ...selected, range: selected.range.cloneRange() }; $('#noteQuote').textContent = pendingNote.text; $('#noteText').value = ''; $('#noteDialog').showModal(); }
$('#noteDialog').addEventListener('close', async () => { const note = pendingNote; pendingNote = null; if ($('#noteDialog').returnValue !== 'save' || !note) return; if (note.editing) { acceptRecords('annotations', await mutateStorage({ operation:'patchRecord', key:'annotations', id:note.record.id, changes:{ note:$('#noteText').value.trim() } })); renderNotes(); return; } if (!activeDocument) return; const record = { id:makeId('note'), documentId:activeDocument.id, documentTitle:activeDocument.title, quote:note.text, context:note.context, anchor:note.anchor, note:$('#noteText').value.trim(), kind:'note', favorite:false, createdAt:Date.now(), updatedAt:Date.now() }; acceptRecords('annotations', await mutateStorage({ operation:'addRecord', key:'annotations', record })); restoreAnnotations(); clearSelection(); });
async function lookupWord(word) {
  openAssistant('Dictionary');
  try {
    const offline = await LeafDictionary.lookup(word);
    if (offline) { const definition = LeafDictionary.markdown(offline); setAssistantResult(definition); const item = vocabulary.find((candidate) => candidate.lemma === lemmaFor(word)); if (item) acceptRecords('vocabulary', await mutateStorage({ operation:'patchRecord', key:'vocabulary', id:item.id, changes:{ definition } })); return; }
    const explanation = await askAI('Explain this English word or short phrase for a Chinese learner. Use concise Markdown with: ## 发音, a contextual Chinese meaning, ## 常见用法 with natural examples, and ## 词性.', word, activeDocument?.text?.slice(0, 500) || '');
    setAssistantResult(explanation);
    const item = vocabulary.find((candidate) => candidate.lemma === lemmaFor(word));
    if (item) acceptRecords('vocabulary', await mutateStorage({ operation:'patchRecord', key:'vocabulary', id:item.id, changes:{ definition:explanation } }));
  } catch (_) {
    try { const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`); if (!response.ok) throw new Error(); const [entry] = await response.json(); const meanings = (entry.meanings || []).slice(0, 3).map((meaning) => `${meaning.partOfSpeech}: ${meaning.definitions?.[0]?.definition || ''}`).join('\n'); const definition = `AI 未配置或不可用，以下为英文词典释义。\n${entry.word}${entry.phonetic ? `  ${entry.phonetic}` : ''}\n${meanings}`; setAssistantResult(definition, false); const item = vocabulary.find((candidate) => candidate.lemma === lemmaFor(word)); if (item) acceptRecords('vocabulary', await mutateStorage({ operation:'patchRecord', key:'vocabulary', id:item.id, changes:{ definition } })); } catch (_) { setAssistantResult('AI 未配置或不可用，且没有找到在线英文词典条目。', false); }
  }
}
function openAssistant(title) { $('#assistantTitle').textContent = title; setAssistantResult('Thinking…', false); $('#assistantPanel').hidden = false; }
async function askAI(instruction, text, context = '') {
  const result = await chrome.runtime.sendMessage({ type:'AI_REQUEST', instruction, text, context });
  if (!result?.ok) throw new Error(result?.error || 'Extension background returned no response.');
  return result.content;
}
function retrievalContext(question) {
  const index = activeSearchIndex || LeafSearch.build(activeDocument?.text || $('#article').innerText);
  const selected = LeafSearch.search(index, question, 6);
  activeSources = selected.map((item) => item.text);
  const coverage = selected.length ? Math.round(selected.reduce((sum, item) => sum + item.coverage, 0) / selected.length * 100) : 0;
  return `检索到 ${selected.length} 段相关内容，平均词项覆盖率 ${coverage}%。\n\n${selected.map((item, source) => `[S${source + 1}] ${item.text}`).join('\n\n')}`;
}
async function askAboutDocument(question) {
  const sources = retrievalContext(question); return askAI(`${question}\n\nAnswer only from the supplied source excerpts. Cite every substantive claim as [S1], [S2], etc. If the sources do not support an answer, say so.`, '', sources);
}
async function aiAction(action) {
  if (!selected) return; const title = action === 'translate' ? 'Translation' : action === 'sentence' ? '难句分析' : '讲解'; openAssistant(title);
  try { setAssistantResult(await askAI(action === 'translate' ? 'Translate naturally. Output the translation first, then only brief notes if needed.' : action === 'sentence' ? 'Analyze this difficult sentence for a Chinese learner. Use concise Markdown sections: ## 句子骨架, ## 从句与修饰关系, ## 难点, and ## 分层翻译.' : 'Explain this word, phrase, or passage: its meaning in context, important usage, and any grammar worth noticing.', selected.text, selected.context)); } catch(error) { setAssistantResult(`Could not reach the AI provider: ${error.message}`, false); } clearSelection();
}
function voiceForLanguage(language) {
  return LeafTts.selectVoice(availableVoices, language, ttsPreferences.voices?.[ttsLanguageKey(language)], ttsPreferences.localOnly);
}
function populateVoices() {
  availableVoices = speechSynthesis.getVoices();
  const select = $('#ttsVoice'); if (!select) return;
  const detectedLanguage = preferredTtsLanguage(selected?.text || activeDocument?.text || $('#article')?.innerText);
  const languageControl = $('#ttsLanguage');
  if (languageControl?.options[0]) languageControl.options[0].textContent = `Current document (${detectedLanguage})`;
  const language = languageControl?.value || detectedLanguage;
  const key = ttsLanguageKey(language);
  const compatible = availableVoices.filter((voice) => ttsLanguageKey(voice.lang) === key);
  const matching = ttsPreferences.localOnly ? compatible.filter((voice) => voice.localService) : compatible;
  const sorted = matching;
  select.dataset.language = language;
  select.innerHTML = `<option value="">Automatic · ${ttsPreferences.localOnly ? 'local only' : 'prefers local'} (${language})</option>${sorted.filter((voice) => !ttsPreferences.localOnly || voice.localService).map((voice) => `<option value="${escapeHtml(voice.voiceURI)}">${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)} · ${voice.localService ? 'Local' : 'Online'}</option>`).join('')}`;
  select.value = sorted.some((voice) => voice.voiceURI === ttsPreferences.voices?.[key]) ? ttsPreferences.voices[key] : '';
  const automatic = voiceForLanguage(language);
  $('#ttsVoiceHelp').textContent = !automatic && ttsPreferences.localOnly
    ? `No installed local ${key.toUpperCase()} voice is available. Install one in the operating system or allow online voices.`
    : select.value
    ? `Saved for ${key.toUpperCase()}; ${matching.find((voice) => voice.voiceURI === select.value)?.localService ? 'runs locally' : 'may use a network service'}.`
    : `Automatic ${key.toUpperCase()} voice: ${automatic ? `${automatic.name} (${automatic.localService ? 'local' : 'online'})` : 'system default'}.`;
}
async function ensureTtsVoices(timeoutMs = 1800) {
  populateVoices(); if (availableVoices.length) return availableVoices;
  if (!voicesLoadingPromise) voicesLoadingPromise = new Promise((resolve) => {
    let timer = 0;
    const finish = () => { clearTimeout(timer); speechSynthesis.removeEventListener('voiceschanged', changed); voicesLoadingPromise = null; populateVoices(); resolve(availableVoices); };
    const changed = () => { if (speechSynthesis.getVoices().length) finish(); };
    speechSynthesis.addEventListener('voiceschanged', changed); timer = setTimeout(finish, timeoutMs);
  });
  return voicesLoadingPromise;
}
async function previewTtsVoice() {
  stopSpeaking(false); const generation = ttsGeneration; await ensureTtsVoices(); if (generation !== ttsGeneration) return;
  const language = $('#ttsVoice').dataset.language || 'en-US'; const voice = voiceForLanguage(language);
  if (ttsPreferences.localOnly && !voice) { showToast(`No installed local ${ttsLanguageKey(language).toUpperCase()} voice is available.`); return; }
  const samples = { zh:'你好，这是 LeafReader 的本地语音试听。', en:'Hello, this is a local voice preview from LeafReader.', ja:'こんにちは。LeafReader の音声プレビューです。', ko:'안녕하세요. LeafReader 음성 미리 듣기입니다.' };
  const sample = samples[ttsLanguageKey(language)] || samples.en; const preview = new SpeechSynthesisUtterance(sample); preview.lang = voice?.lang || language; preview.rate = Math.min(1.5, Math.max(.7, Number(ttsPreferences.rate) || 1)); preview.pitch = Math.min(1.2, Math.max(.8, Number(ttsPreferences.pitch) || 1)); if (voice) preview.voice = voice; speechSynthesis.speak(preview);
}
function sentenceQueue(text) {
  return speechChunks(text).map((entry) => ({ ...entry, range:null, map:null }));
}
function mappedRange(map, start, end) {
  const first = map[start]; const last = map[Math.max(start, end - 1)];
  if (!first || !last) return null;
  const range = document.createRange(); range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset + 1); return range;
}
function articleSentenceQueue() {
  const root = $('#article'); const nodes = []; const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node;
  while ((node = walker.nextNode())) nodes.push(node);
  const chars = []; const map = []; let whitespace = false;
  for (const textNode of nodes) for (let offset = 0; offset < textNode.nodeValue.length; offset += 1) { const char = textNode.nodeValue[offset]; if (/\s/.test(char)) { if (!whitespace) { chars.push(' '); map.push({ node:textNode, offset }); whitespace = true; } } else { chars.push(char); map.push({ node:textNode, offset }); whitespace = false; } }
  const rawText = chars.join(''); const leading = rawText.length - rawText.trimStart().length; const text = rawText.trim(); if (!text) return [];
  return speechChunks(text).map((entry) => { const start = leading + entry.start; const end = leading + entry.end; return { ...entry, start, end, map, range:mappedRange(map, start, end) }; });
}
function setTtsHighlight(range) {
  if (!window.CSS?.highlights || !window.Highlight) return;
  if (!range) { window.CSS.highlights.delete('leafreader-tts'); activeTtsHighlight = null; return; }
  activeTtsHighlight = new Highlight(range); window.CSS.highlights.set('leafreader-tts', activeTtsHighlight); range.getBoundingClientRect && range.startContainer.parentElement?.scrollIntoView({ block:'center', behavior:'smooth' });
}
function stopSpeaking(preservePosition = true) {
  if (preservePosition && ttsForDocument && activeDocument && ttsQueue.length && ttsIndex < ttsQueue.length) { activeDocument.ttsSentenceIndex = ttsIndex; scheduleDocumentSave(0); }
  ttsGeneration += 1; speechSynthesis.cancel(); speaking = false; ttsPaused = false; ttsQueue = []; ttsIndex = 0; ttsForDocument = false; setTtsHighlight(null); $('#ttsToggle').classList.remove('active');
}
function speakNext() {
  if (!speaking || ttsPaused || ttsIndex >= ttsQueue.length) { if (ttsIndex >= ttsQueue.length) { if (ttsForDocument && activeDocument) { activeDocument.ttsSentenceIndex = 0; scheduleDocumentSave(0); } stopSpeaking(false); } return; }
  if (ttsForDocument && activeDocument) { activeDocument.ttsSentenceIndex = ttsIndex; scheduleDocumentSave(); }
  const generation = ttsGeneration; const sentence = ttsQueue[ttsIndex]; const language = sentence.language || preferredTtsLanguage(sentence.text); const voice = voiceForLanguage(language); const spokenText = LeafTts.speechText(sentence.text, language);
  if (!spokenText) { ttsIndex += 1; speakNext(); return; }
  if (ttsPreferences.localOnly && !voice) { showToast(`Reading stopped because no installed local ${ttsLanguageKey(language).toUpperCase()} voice is available.`); stopSpeaking(false); return; }
  setTtsHighlight(sentence.range); utterance = new SpeechSynthesisUtterance(spokenText); utterance.lang = voice?.lang || language; utterance.rate = Math.min(1.5, Math.max(.7, Number(ttsPreferences.rate) || 1)); utterance.pitch = Math.min(1.2, Math.max(.8, Number(ttsPreferences.pitch) || 1));
  if (voice) utterance.voice = voice;
  utterance.onboundary = (event) => {
    if (generation !== ttsGeneration || spokenText !== sentence.text || !sentence.map || !Number.isFinite(event.charIndex)) return;
    const remaining = sentence.text.slice(event.charIndex); const token = remaining.match(/^[\p{L}\p{N}'-]+/u)?.[0] || remaining[0] || '';
    const length = Number(event.charLength) > 0 ? event.charLength : token.length;
    const range = mappedRange(sentence.map, sentence.start + event.charIndex, sentence.start + event.charIndex + Math.max(1, length));
    if (range) setTtsHighlight(range);
  };
  utterance.onend = () => { if (generation !== ttsGeneration || !speaking || ttsPaused) return; ttsIndex += 1; speakNext(); };
  utterance.onerror = (event) => { if (generation !== ttsGeneration) return; if (event.error !== 'interrupted' && event.error !== 'canceled') { ttsIndex += 1; speakNext(); } };
  speechSynthesis.speak(utterance);
}
async function speak() {
  const selection = selected?.text || ''; stopSpeaking(); const generation = ttsGeneration; clearSelection(); await ensureTtsVoices(); if (generation !== ttsGeneration) return; ttsForDocument = !selection; ttsQueue = selection ? sentenceQueue(selection) : articleSentenceQueue(); if (!ttsQueue.length) return; if (ttsForDocument) ttsIndex = Math.min(Math.max(0, Number(activeDocument?.ttsSentenceIndex || 0)), ttsQueue.length - 1); speaking = true; $('#ttsToggle').classList.add('active'); speakNext();
}
function toggleSpeaking() {
  if (!speaking) { void speak(); return; }
  if (speechSynthesis.paused || ttsPaused) { ttsPaused = false; speechSynthesis.resume(); return; }
  ttsPaused = true; speechSynthesis.pause();
}
function restartSpeakingAtCurrentChunk() {
  if (!speaking) return;
  const documentQueue = ttsForDocument; const resumeAt = ttsIndex; const remaining = ttsQueue.slice(ttsIndex); stopSpeaking(false); ttsForDocument = documentQueue; ttsQueue = documentQueue ? articleSentenceQueue() : remaining; ttsIndex = documentQueue ? resumeAt : 0; speaking = true; $('#ttsToggle').classList.add('active'); speakNext();
}
function highlightSearch() {
  $('#article').querySelectorAll('mark.search-hit').forEach((node) => node.replaceWith(document.createTextNode(node.textContent)));
  readerTextIndex = null;
  const term = $('#inDocumentSearch').value.trim(); searchHits=[]; matchIndex=-1; if (!term) { restoreAnnotations(); $('#searchCount').textContent=''; return; }
  const walker=document.createTreeWalker($('#article'),NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('mark')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT}); let node; const nodes=[]; while(node=walker.nextNode())nodes.push(node);
  nodes.reverse().forEach((textNode)=>{ const haystack=textNode.nodeValue.toLowerCase(); const needle=term.toLowerCase(); let index=haystack.lastIndexOf(needle); while(index>=0){const after=textNode.splitText(index+term.length);const match=textNode.splitText(index);const mark=document.createElement('mark');mark.className='search-hit';match.parentNode.replaceChild(mark,match);mark.append(match);searchHits.unshift(mark);index=textNode.nodeValue.toLowerCase().lastIndexOf(needle,index-1); if(!after)break;} });
  readerTextIndex = null; restoreAnnotations();
  $('#searchCount').textContent = `${searchHits.length} found`; if(searchHits.length) moveMatch(1);
}
function moveMatch(delta) { if(!searchHits.length)return; searchHits.forEach(hit=>hit.classList.remove('current')); matchIndex=(matchIndex+delta+searchHits.length)%searchHits.length; searchHits[matchIndex].classList.add('current'); searchHits[matchIndex].scrollIntoView({block:'center',behavior:'smooth'}); }

function bind() {
  $$('.nav[data-view]').forEach((button) => button.onclick = () => { showView(button.dataset.view); refreshLibrary(); });
  $('#exportNotesMarkdown').onclick = () => downloadExport('leafreader-notes.md', notesMarkdown(), 'text/markdown');
  $('#exportNotesJson').onclick = () => downloadExport('leafreader-notes.json', JSON.stringify(annotations, null, 2));
  $('#exportWordsJson').onclick = () => downloadExport('leafreader-vocabulary.json', JSON.stringify(vocabulary, null, 2));
  $('#reviewDue').onclick = () => { const word = [...vocabulary].sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0)).find((item) => (item.dueAt || 0) <= Date.now()); if (!word) { showToast('No vocabulary is due for review.'); return; } document.querySelector(`[data-review-word="${CSS.escape(word.id)}"]`)?.closest('.record')?.scrollIntoView({ block:'center', behavior:'smooth' }); };
  $('#openPage').onclick = $('#openPage2').onclick = $('#emptyOpen').onclick = () => chrome.runtime.sendMessage({ type:'OPEN_ACTIVE_PAGE' });
  $('#settings').onclick = () => chrome.runtime.openOptionsPage();
  $('#librarySearch').oninput = () => dbAll().then(renderDocuments); $('#sortDocuments').onchange = () => dbAll().then(renderDocuments);
  $('#backLibrary').onclick = async () => { stopSpeaking(); saveProgress(); await flushDocumentState(); showView('library'); refreshLibrary(); };
  $('#searchToggle').onclick = () => { $('#searchBar').hidden = !$('#searchBar').hidden; if(!$('#searchBar').hidden)$('#inDocumentSearch').focus(); };
  $('#closeSearch').onclick = () => { $('#searchBar').hidden=true; $('#inDocumentSearch').value=''; highlightSearch(); }; $('#inDocumentSearch').oninput=highlightSearch; $('#nextMatch').onclick=()=>moveMatch(1); $('#previousMatch').onclick=()=>moveMatch(-1);
  $('#readerSettings').onclick=()=>$('#readingSettings').hidden=!$('#readingSettings').hidden; [['fontSize','--text-size','leaf-font-size','px'],['textWidth','--text-width','leaf-text-width','px'],['lineHeight','--leading','leaf-leading','']].forEach(([id,prop,key,unit])=>$('#'+id).oninput=(event)=>{ $('#article').style.setProperty(prop,event.target.value+unit); localStorage.setItem(key,event.target.value); });
  $('#themeToggle').onclick=()=>document.body.classList.toggle('dark'); $('#ttsToggle').onclick=toggleSpeaking;
  $('#ttsLanguage').onchange = populateVoices;
  $('#ttsLocalOnly').onchange = (event) => { ttsPreferences = { ...ttsPreferences, localOnly:event.target.checked }; void chrome.storage.local.set({ ttsPreferences }); populateVoices(); restartSpeakingAtCurrentChunk(); };
  $('#ttsVoice').onchange = (event) => {
    const key = ttsLanguageKey(event.target.dataset.language); const voices = { ...(ttsPreferences.voices || {}) }; if (event.target.value) voices[key] = event.target.value; else delete voices[key]; ttsPreferences = { ...ttsPreferences, voices }; void chrome.storage.local.set({ ttsPreferences }); populateVoices();
    restartSpeakingAtCurrentChunk();
  };
  $('#ttsPreview').onclick = () => void previewTtsVoice();
  $('#ttsRate').value = ttsPreferences.rate; $('#ttsRate').oninput = (event) => { ttsPreferences = { ...ttsPreferences, rate:Number(event.target.value) }; void chrome.storage.local.set({ ttsPreferences }); };
  $('#ttsPitch').value = ttsPreferences.pitch; $('#ttsPitch').oninput = (event) => { ttsPreferences = { ...ttsPreferences, pitch:Number(event.target.value) }; void chrome.storage.local.set({ ttsPreferences }); };
  $('#aiSummary').onclick=async()=>{ if(!activeDocument)return; openAssistant('Reading summary'); try { setAssistantResult(await askAboutDocument('Summarize this reading in 3–5 concise key points, then list important people, events, or ideas and one reading note.')); } catch(error) { setAssistantResult(`Could not reach the AI provider: ${error.message}`, false); } };
  $('#selectionToolbar').onmousedown = (event) => event.preventDefault();
  $('#selectionToolbar').onclick=(event)=>{const action=event.target.closest('button')?.dataset.action;if(!action)return;if(action==='note')openNote();if(action==='word')addWord();if(action==='translate'||action==='sentence'||action==='explain')aiAction(action);if(action==='speak')speak();};
  $('#closeAssistant').onclick=()=>$('#assistantPanel').hidden=true; $('#followUpForm').onsubmit=async(event)=>{event.preventDefault();const question=$('#followUp').value.trim();if(!question)return;openAssistant('LeafReader AI');try{setAssistantResult(await askAboutDocument(question));}catch(error){setAssistantResult(`Could not reach the AI provider: ${error.message}`, false);}$('#followUp').value='';};
  $('#article').onclick=(event)=>{ if (!getSelection()?.isCollapsed) return; const point=document.caretRangeFromPoint?.(event.clientX,event.clientY)||(()=>{const position=document.caretPositionFromPoint?.(event.clientX,event.clientY);if(!position)return null;const range=document.createRange();range.setStart(position.offsetNode,position.offset);range.collapse(true);return range;})();if(!point)return;const hit=[...readerPaintedRanges].reverse().find(({range})=>{try{return range.isPointInRange(point.startContainer,point.startOffset);}catch(_){return false;}});const item=hit?.record;if(item?.note)showToast(item.note);else if(item?.definition){openAssistant('单词释义');setAssistantResult(item.definition);$('#assistantPanel').hidden=false;}};
  }
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.annotations) { annotations = changes.annotations.newValue || []; renderNotes(); if (activeDocument) restoreAnnotations(); }
  if (changes.vocabulary) { vocabulary = changes.vocabulary.newValue || []; renderWords(); if (activeDocument) restoreAnnotations(); }
});
bind(); populateVoices(); speechSynthesis.addEventListener('voiceschanged', populateVoices); loadState().catch((error)=>showToast(`LeafReader could not open its library: ${error.message}`));
