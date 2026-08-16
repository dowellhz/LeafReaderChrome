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
let ttsForDocument = false;

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
function dbPut(doc) { return new Promise((resolve, reject) => { const req = store('documents', 'readwrite').put(doc); req.onsuccess = () => resolve(doc); req.onerror = () => reject(req.error); }); }
function dbDelete(id) { return new Promise((resolve, reject) => { const req = store('documents', 'readwrite').delete(id); req.onsuccess = resolve; req.onerror = () => reject(req.error); }); }
const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const cleanText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const makeId = (kind) => `${kind}:${crypto.randomUUID()}`;
const relativeDate = (ms) => { const days = Math.floor((Date.now() - ms) / 86400000); return !days ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`; };
const annotationLabel = (kind) => ({ highlight: 'Highlight', note: 'Note', translation: 'Translation', dictionary: 'Dictionary', explanation: 'AI explanation' }[kind] || 'Highlight');
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
  const data = await chrome.storage.local.get(['annotations', 'vocabulary', 'settings']);
  annotations = data.annotations || [];
  vocabulary = data.vocabulary || [];
  let vocabularyMigrated = false;
  vocabulary.forEach((item) => {
    if (!item.lemma) { item.lemma = lemmaFor(item.word); vocabularyMigrated = true; }
    if (!item.status) { item.status = 'new'; vocabularyMigrated = true; }
    if (!Number.isFinite(item.dueAt)) { item.dueAt = item.createdAt || Date.now(); vocabularyMigrated = true; }
    if (!Number.isFinite(item.intervalDays)) { item.intervalDays = 0; vocabularyMigrated = true; }
    if (!Number.isFinite(item.reviewCount)) { item.reviewCount = 0; vocabularyMigrated = true; }
    if (!Number.isFinite(item.correctCount)) { item.correctCount = 0; vocabularyMigrated = true; }
  });
  if (vocabularyMigrated) await chrome.storage.local.set({ vocabulary });
  settings = { ...settings, ...(data.settings || {}) };
  document.documentElement.dataset.font = settings.font;
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
async function persistRecords() { await chrome.storage.local.set({ annotations, vocabulary }); }
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
function renderNotes() {
  const latest = [...annotations].sort((a,b) => b.createdAt - a.createdAt);
  $('#notesList').innerHTML = latest.length ? latest.map((note) => `<article class="record"><div class="record-actions"><button title="Delete marker" data-delete-note="${note.id}">×</button><button title="${note.favorite ? 'Remove favorite' : 'Favorite'}" data-favorite-note="${note.id}">${note.favorite ? '★' : '☆'}</button><button title="Edit note" data-edit-note="${note.id}">✎</button>${note.documentId?.startsWith('web:') ? `<button title="Open webpage" data-open-note="${note.id}">↗</button>` : ''}</div><blockquote>${escapeHtml(note.quote)}</blockquote>${note.note ? `<p>${escapeHtml(note.note)}</p>` : ''}<small>${annotationLabel(note.kind)} · ${escapeHtml(note.documentTitle || 'Reading')} · ${relativeDate(note.createdAt)}</small></article>`).join('') : `<div class="empty"><div class="leaf-illustration">✎</div><h2>No markers yet</h2><p>Select text while reading, then choose a reading action.</p></div>`;
  $$('[data-delete-note]').forEach((button) => button.onclick = async () => { annotations = annotations.filter((note) => note.id !== button.dataset.deleteNote); await persistRecords(); renderNotes(); });
  $$('[data-favorite-note]').forEach((button) => button.onclick = async () => { const note = annotations.find((item) => item.id === button.dataset.favoriteNote); if (!note) return; note.favorite = !note.favorite; note.updatedAt = Date.now(); await persistRecords(); renderNotes(); });
  $$('[data-edit-note]').forEach((button) => button.onclick = () => { const note = annotations.find((item) => item.id === button.dataset.editNote); if (!note) return; pendingNote = { record: note, editing: true }; $('#noteQuote').textContent = note.quote; $('#noteText').value = note.note || ''; $('#noteDialog').showModal(); });
  $$('[data-open-note]').forEach((button) => button.onclick = () => chrome.runtime.sendMessage({ type:'OPEN_DOCUMENT_SOURCE', documentId:annotations.find((item) => item.id === button.dataset.openNote)?.documentId }));
}
function renderWords() {
  const latest = [...vocabulary].sort((a,b) => (a.dueAt || Infinity) - (b.dueAt || Infinity) || b.createdAt - a.createdAt);
  const due = latest.filter((word) => (word.dueAt || 0) <= Date.now()).length;
  $('#reviewDue').textContent = due ? `Review ${due}` : 'Review due';
  $('#wordsList').innerHTML = latest.length ? latest.map((word) => `<article class="record word-record"><div class="record-actions"><button title="Remove word" data-delete-word="${word.id}">×</button><button title="Look up definition" data-lookup-word="${word.id}">⌕</button><button title="Mark known" data-known-word="${word.id}">✓</button></div><blockquote>${escapeHtml(word.word)}</blockquote>${word.definition ? `<p class="word-definition">${escapeHtml(word.definition)}</p>` : '<p class="muted">No definition yet — use the search button to look it up.</p>'}<div class="review-actions"><button data-review-word="${word.id}" data-quality="again">Again</button><button data-review-word="${word.id}" data-quality="good">Remember</button></div><small>${escapeHtml(word.status || 'new')} · seen ${word.occurrences || 1}× · reviewed ${word.reviewCount || 0}×${word.dueAt ? ` · ${word.dueAt <= Date.now() ? 'due now' : `next ${new Date(word.dueAt).toLocaleDateString()}`}` : ''}</small></article>`).join('') : `<div class="empty"><div class="leaf-illustration">◎</div><h2>Your vocabulary will grow here</h2><p>Select a word or phrase and save it while reading.</p></div>`;
  $$('[data-delete-word]').forEach((button) => button.onclick = async () => { vocabulary = vocabulary.filter((word) => word.id !== button.dataset.deleteWord); await persistRecords(); renderWords(); });
  $$('[data-known-word]').forEach((button) => button.onclick = async () => { const word = vocabulary.find((item) => item.id === button.dataset.knownWord); if (!word) return; word.status = 'known'; word.dueAt = Date.now() + 30 * 86400000; word.intervalDays = 30; word.updatedAt = Date.now(); await persistRecords(); renderWords(); });
  $$('[data-lookup-word]').forEach((button) => button.onclick = () => { const word = vocabulary.find((item) => item.id === button.dataset.lookupWord); if (word) lookupWord(word.word); });
  $$('[data-review-word]').forEach((button) => button.onclick = async () => { const word = vocabulary.find((item) => item.id === button.dataset.reviewWord); if (!word) return; const correct = button.dataset.quality === 'good'; word.reviewCount = Number(word.reviewCount || 0) + 1; word.correctCount = Number(word.correctCount || 0) + (correct ? 1 : 0); word.intervalDays = correct ? Math.min(90, Math.max(1, Math.round((word.intervalDays || 0) * 2.4) || 1)) : 1; word.status = correct ? 'learning' : 'new'; word.dueAt = Date.now() + word.intervalDays * 86400000; word.updatedAt = Date.now(); await persistRecords(); renderWords(); });
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
function setAssistantResult(value, markdown = true) {
  const panel = $('#assistantResult'); panel.innerHTML = markdown ? renderAssistantMarkdown(value).replace(/\[S(\d+)\]/g, '<button class="source-cite" data-source="$1">[S$1]</button>') : `<p>${escapeHtml(value)}</p>`;
  panel.querySelectorAll('[data-source]').forEach((button) => button.onclick = () => { const source = activeSources[Number(button.dataset.source) - 1]; if (!source) return; const range = rangeForQuote(source.slice(0, 220)); if (!range) { showToast('This source could not be located in the current webpage.'); return; } if (window.CSS?.highlights && window.Highlight) window.CSS.highlights.set('leafreader-source', new Highlight(range)); range.startContainer.parentElement?.scrollIntoView({ block:'center', behavior:'smooth' }); });
}

async function openDocument(id) {
  stopSpeaking();
  const doc = await dbGet(id); if (!doc) return;
  activeDocument = { ...doc, lastOpenedAt: Date.now() }; await dbPut(activeDocument);
  $('#readerTitle').textContent = doc.title; $('#readerMeta').textContent = doc.byline || doc.sourceUrl || doc.type || '';
  showView('reader');
  $('#article').style.setProperty('--text-size', `${localStorage.getItem('leaf-font-size') || 18}px`);
  $('#article').style.setProperty('--text-width', `${localStorage.getItem('leaf-text-width') || 720}px`);
  $('#article').style.setProperty('--leading', localStorage.getItem('leaf-leading') || 1.8);
  $('#fontSize').value = localStorage.getItem('leaf-font-size') || 18; $('#textWidth').value = localStorage.getItem('leaf-text-width') || 720; $('#lineHeight').value = localStorage.getItem('leaf-leading') || 1.8;
  $('#article').innerHTML = sanitizeHtml(doc.html || `<p>${escapeHtml(doc.text)}</p>`);
  restoreAnnotations();
  window.scrollTo({ top: Math.max(0, (doc.progress || 0) * Math.max(0, document.documentElement.scrollHeight - innerHeight)), behavior: 'instant' });
}
function saveProgress() {
  if (!activeDocument || !$('#readerView').classList.contains('active')) return;
  const total = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  activeDocument.progress = Math.min(1, Math.max(0, scrollY / total)); activeDocument.lastOpenedAt = Date.now();
  $('#progressBar').style.width = `${activeDocument.progress * 100}%`; dbPut(activeDocument);
}
let scrollTick = 0;
addEventListener('scroll', () => { cancelAnimationFrame(scrollTick); scrollTick = requestAnimationFrame(saveProgress); }, { passive: true });

function rangeForQuote(quote, occurrence = 0, root = $('#article')) {
  const target = cleanText(quote); if (!target) return null;
  const nodes = []; const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement.closest('.leaf-highlight,.leaf-note,.leaf-word') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  let node; while ((node = walker.nextNode())) nodes.push(node);
  const full = nodes.map((node) => node.nodeValue).join(''); let cursor = 0; let found = -1;
  for (let i=0; i<=occurrence; i++) { found = full.toLowerCase().indexOf(target.toLowerCase(), cursor); if (found < 0) return null; cursor = found + target.length; }
  let startNode, endNode, startOffset, endOffset, position = 0;
  for (const textNode of nodes) { const next = position + textNode.nodeValue.length; if (!startNode && found >= position && found <= next) { startNode = textNode; startOffset = found - position; } if (startNode && found + target.length <= next) { endNode = textNode; endOffset = found + target.length - position; break; } position = next; }
  if (!startNode || !endNode) return null; const range = document.createRange(); range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset); return range;
}
function wrapRange(range, className, id) {
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT); const targets = []; let node;
  while ((node = walker.nextNode())) { if (!range.intersectsNode(node) || !node.nodeValue.trim()) continue; const start = node === range.startContainer ? range.startOffset : 0; const end = node === range.endContainer ? range.endOffset : node.nodeValue.length; if (end > start) targets.push({ node, start, end }); }
  if (range.startContainer.nodeType === Node.TEXT_NODE && !targets.some((item) => item.node === range.startContainer)) targets.unshift({node:range.startContainer,start:range.startOffset,end:range.endContainer === range.startContainer ? range.endOffset : range.startContainer.nodeValue.length});
  targets.reverse().forEach(({node,start,end}) => { let mid=node; if (end < mid.nodeValue.length) mid=mid.splitText(end); if (start) mid=mid.splitText(start); const span=document.createElement('mark'); span.className=className; span.dataset.annotationId=id; mid.parentNode.insertBefore(span,mid); span.append(mid); });
}
function restoreAnnotations() {
  const classForAnnotation = (kind) => ({ note:'leaf-note', translation:'leaf-translation', dictionary:'leaf-dictionary', explanation:'leaf-explanation' }[kind] || 'leaf-highlight');
  annotations.filter((item) => item.documentId === activeDocument.id).sort((a,b) => b.createdAt - a.createdAt).forEach((item) => { const range = rangeForQuote(item.quote); if (range) wrapRange(range, classForAnnotation(item.kind), item.id); });
  vocabulary.filter((item) => item.documentId === activeDocument.id).sort((a,b) => b.createdAt - a.createdAt).forEach((item) => { const range = rangeForQuote(item.word); if (range) wrapRange(range, 'leaf-word', item.id); });
}
function selectionChanged() {
  const current = getSelection(); const text = cleanText(current?.toString()); const range = current?.rangeCount ? current.getRangeAt(0) : null;
  if (!text || !range || !$('#article').contains(range.commonAncestorContainer)) { $('#selectionToolbar').hidden = true; selected = null; return; }
  selected = { text, range: range.cloneRange(), context: cleanText(range.commonAncestorContainer.parentElement?.innerText).slice(0, 450), locator: null };
  const rect = range.getBoundingClientRect(); const bar = $('#selectionToolbar'); bar.hidden = false; bar.style.left = `${Math.max(8, Math.min(innerWidth - 260, rect.left + rect.width / 2 - 110))}px`; bar.style.top = `${Math.max(8, rect.top - 46)}px`;
}
document.addEventListener('selectionchange', () => requestAnimationFrame(selectionChanged));
function clearSelection() { getSelection()?.removeAllRanges(); $('#selectionToolbar').hidden = true; }
async function addHighlight() {
  if (!selected || !activeDocument) return;
  const record = { id: makeId('highlight'), documentId: activeDocument.id, documentTitle: activeDocument.title, quote: selected.text, context: selected.context, locator: selected.locator, kind: 'highlight', createdAt: Date.now() };
  annotations.push(record); wrapRange(selected.range, 'leaf-highlight', record.id); await persistRecords(); clearSelection();
}
async function addWord() {
  if (!selected || !activeDocument) return;
  const word = selected.text.slice(0, 160); const lemma = lemmaFor(word); const existing = vocabulary.find((item) => item.lemma === lemma);
  if (existing) { existing.occurrences = Number(existing.occurrences || 1) + 1; existing.lastSeenAt = Date.now(); existing.updatedAt = Date.now(); existing.documentIds = [...new Set([...(existing.documentIds || [existing.documentId].filter(Boolean)), activeDocument.id])]; await persistRecords(); wrapRange(selected.range, 'leaf-word', existing.id); showToast(`Vocabulary updated: seen ${existing.occurrences} times.`); clearSelection(); return; }
  vocabulary.push({ id: makeId('word'), documentId: activeDocument.id, documentTitle: activeDocument.title, word, lemma, context: selected.context, contexts:[selected.context], documentIds:[activeDocument.id], locator: selected.locator, definition: '', occurrences:1, status:'new', intervalDays:0, dueAt:Date.now(), reviewCount:0, correctCount:0, createdAt: Date.now(), updatedAt:Date.now() }); wrapRange(selected.range, 'leaf-word', vocabulary.at(-1).id); await persistRecords();
  clearSelection(); await lookupWord(word);
}
function openNote() { if (!selected) return; pendingNote = { ...selected, range: selected.range.cloneRange() }; $('#noteQuote').textContent = pendingNote.text; $('#noteText').value = ''; $('#noteDialog').showModal(); }
$('#noteDialog').addEventListener('close', async () => { const note = pendingNote; pendingNote = null; if ($('#noteDialog').returnValue !== 'save' || !note) return; if (note.editing) { note.record.note = $('#noteText').value.trim(); note.record.updatedAt = Date.now(); await persistRecords(); renderNotes(); return; } if (!activeDocument) return; const record = { id: makeId('note'), documentId: activeDocument.id, documentTitle: activeDocument.title, quote: note.text, context: note.context, locator: note.locator, note: $('#noteText').value.trim(), kind:'note', favorite:false, createdAt:Date.now(), updatedAt:Date.now() }; annotations.push(record); wrapRange(note.range, 'leaf-note', record.id); await persistRecords(); clearSelection(); });
async function lookupWord(word) {
  openAssistant('Dictionary');
  try {
    const explanation = await askAI('Explain this English word or short phrase for a Chinese learner. Use concise Markdown with: ## 发音, a contextual Chinese meaning, ## 常见用法 with natural examples, and ## 词性.', word, activeDocument?.text?.slice(0, 500) || '');
    setAssistantResult(explanation);
    const item = vocabulary.find((candidate) => candidate.lemma === lemmaFor(word));
    if (item) { item.definition = explanation; await persistRecords(); }
  } catch (_) {
    try { const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`); if (!response.ok) throw new Error(); const [entry] = await response.json(); const meanings = (entry.meanings || []).slice(0, 3).map((meaning) => `${meaning.partOfSpeech}: ${meaning.definitions?.[0]?.definition || ''}`).join('\n'); const definition = `AI 未配置或不可用，以下为英文词典释义。\n${entry.word}${entry.phonetic ? `  ${entry.phonetic}` : ''}\n${meanings}`; setAssistantResult(definition, false); const item = vocabulary.find((candidate) => candidate.lemma === lemmaFor(word)); if (item) { item.definition = definition; item.updatedAt = Date.now(); await persistRecords(); } } catch (_) { setAssistantResult('AI 未配置或不可用，且没有找到在线英文词典条目。', false); }
  }
}
function openAssistant(title) { $('#assistantTitle').textContent = title; setAssistantResult('Thinking…', false); $('#assistantPanel').hidden = false; }
async function askAI(instruction, text, context = '') {
  const result = await chrome.runtime.sendMessage({ type:'AI_REQUEST', instruction, text, context });
  if (!result?.ok) throw new Error(result?.error || 'Extension background returned no response.');
  return result.content;
}
function documentChunks(text, size = 1500) {
  const paragraphs = String(text || '').split(/\n{2,}/).map(cleanText).filter(Boolean); const units = [];
  for (const paragraph of paragraphs) { if (paragraph.length <= size) units.push(paragraph); else { let rest = paragraph; while (rest.length > size) { const window = rest.slice(0, size + 1); const boundary = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf(' ')); const cut = boundary > size * .45 ? boundary + 1 : size; units.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim(); } if (rest) units.push(rest); } }
  const chunks = []; let current = '';
  for (const paragraph of units) { if (current && current.length + paragraph.length + 2 > size) { chunks.push(current); current = ''; } current += `${current ? '\n\n' : ''}${paragraph}`; }
  if (current) chunks.push(current); return chunks;
}
function retrievalContext(question) {
  const chunks = documentChunks(activeDocument?.text || $('#article').innerText); const tokens = cleanText(question).toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  const scored = chunks.map((chunk, index) => ({ chunk, index, score:tokens.reduce((score, token) => score + (chunk.toLocaleLowerCase().match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 0) })).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = (scored.some((item) => item.score) ? scored.slice(0, 5) : scored.slice(0, 6));
  activeSources = selected.map((item) => item.chunk); return selected.map((item, source) => `[S${source + 1}] ${item.chunk}`).join('\n\n');
}
async function askAboutDocument(question) {
  const sources = retrievalContext(question); return askAI(`${question}\n\nAnswer only from the supplied source excerpts. Cite every substantive claim as [S1], [S2], etc. If the sources do not support an answer, say so.`, '', sources);
}
async function aiAction(action) {
  if (!selected) return; const title = action === 'translate' ? 'Translation' : 'AI explanation'; openAssistant(title);
  try { setAssistantResult(await askAI(action === 'translate' ? 'Translate naturally. Output the translation first, then only brief notes if needed.' : 'Explain this word, phrase, or passage: its meaning in context, important usage, and any grammar worth noticing.', selected.text, selected.context)); } catch(error) { setAssistantResult(`Could not reach the AI provider: ${error.message}`, false); } clearSelection();
}
function preferredTtsLanguage(text = '') {
  const value = String(text || '');
  // Speech language must follow the text, not the AI/UI language. Otherwise an
  // English article in a Chinese Chrome UI gets read with a Chinese voice.
  if (/[\u3040-\u30ff]/.test(value)) return 'ja-JP';
  if (/[\uac00-\ud7af]/.test(value)) return 'ko-KR';
  if (/[\u3400-\u9fff]/.test(value)) return 'zh-CN';
  return 'en-US';
}
function populateVoices() {
  availableVoices = speechSynthesis.getVoices(); const select = $('#ttsVoice'); if (!select) return;
  const current = localStorage.getItem('leaf-tts-voice') || ''; const language = preferredTtsLanguage(selected?.text || activeDocument?.text || $('#article')?.innerText); const matching = availableVoices.filter((voice) => voice.lang.toLowerCase().startsWith(language.slice(0, 2))).concat(availableVoices.filter((voice) => !voice.lang.toLowerCase().startsWith(language.slice(0, 2))));
  select.innerHTML = `<option value="">System default (${language})</option>${matching.map((voice) => `<option value="${escapeHtml(voice.voiceURI)}">${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}</option>`).join('')}`; select.value = matching.some((voice) => voice.voiceURI === current) ? current : '';
}
function sentenceQueue(text) {
  const value = cleanText(text); if (!value) return [];
  if (Intl.Segmenter) return [...new Intl.Segmenter(preferredTtsLanguage(value), { granularity:'sentence' }).segment(value)].map((entry) => ({ text:entry.segment.trim(), range:null })).filter((entry) => entry.text);
  return (value.match(/[^.!?。！？]+[.!?。！？]*|.+$/g)?.map((part) => part.trim()).filter(Boolean) || []).map((text) => ({ text, range:null }));
}
function articleSentenceQueue() {
  const root = $('#article'); const nodes = []; const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode:(node) => node.parentElement.closest('mark,.search-hit') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT }); let node;
  while ((node = walker.nextNode())) nodes.push(node);
  const chars = []; const map = []; let whitespace = false;
  for (const textNode of nodes) for (let offset = 0; offset < textNode.nodeValue.length; offset += 1) { const char = textNode.nodeValue[offset]; if (/\s/.test(char)) { if (!whitespace) { chars.push(' '); map.push({ node:textNode, offset }); whitespace = true; } } else { chars.push(char); map.push({ node:textNode, offset }); whitespace = false; } }
  const rawText = chars.join(''); const leading = rawText.length - rawText.trimStart().length; const text = rawText.trim(); if (!text) return [];
  let fallbackOffset = 0;
  const segments = Intl.Segmenter ? [...new Intl.Segmenter(preferredTtsLanguage(text), { granularity:'sentence' }).segment(text)].map(({ segment, index }) => ({ text:segment.trim(), start:index + segment.indexOf(segment.trim()) })) : (text.match(/[^.!?。！？]+[.!?。！？]*|.+$/g) || []).map((segment) => { const start = fallbackOffset + segment.indexOf(segment.trim()); fallbackOffset += segment.length; return { text:segment.trim(), start }; });
  return segments.filter((entry) => entry.text).map((entry) => { const start = leading + entry.start; const end = start + entry.text.length; const first = map[start]; const last = map[end - 1]; let range = null; if (first && last) { range = document.createRange(); range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset + 1); } return { text:entry.text, range }; });
}
function setTtsHighlight(range) {
  if (!window.CSS?.highlights || !window.Highlight) return;
  if (!range) { window.CSS.highlights.delete('leafreader-tts'); activeTtsHighlight = null; return; }
  activeTtsHighlight = new Highlight(range); window.CSS.highlights.set('leafreader-tts', activeTtsHighlight); range.getBoundingClientRect && range.startContainer.parentElement?.scrollIntoView({ block:'center', behavior:'smooth' });
}
function stopSpeaking(preservePosition = true) {
  if (preservePosition && ttsForDocument && activeDocument && ttsQueue.length && ttsIndex < ttsQueue.length) { activeDocument.ttsSentenceIndex = ttsIndex; dbPut(activeDocument); }
  speechSynthesis.cancel(); speaking = false; ttsPaused = false; ttsQueue = []; ttsIndex = 0; ttsForDocument = false; setTtsHighlight(null); $('#ttsToggle').classList.remove('active');
}
function speakNext() {
  if (!speaking || ttsPaused || ttsIndex >= ttsQueue.length) { if (ttsIndex >= ttsQueue.length) { if (ttsForDocument && activeDocument) { activeDocument.ttsSentenceIndex = 0; dbPut(activeDocument); } stopSpeaking(false); } return; }
  if (ttsForDocument && activeDocument) { activeDocument.ttsSentenceIndex = ttsIndex; dbPut(activeDocument); }
  const sentence = ttsQueue[ttsIndex]; setTtsHighlight(sentence.range); utterance = new SpeechSynthesisUtterance(sentence.text); utterance.lang = preferredTtsLanguage(sentence.text); utterance.rate = Number(localStorage.getItem('leaf-tts-rate') || 1);
  const voice = availableVoices.find((item) => item.voiceURI === localStorage.getItem('leaf-tts-voice')); if (voice) utterance.voice = voice;
  utterance.onend = () => { if (!speaking || ttsPaused) return; ttsIndex += 1; speakNext(); };
  utterance.onerror = (event) => { if (event.error !== 'interrupted' && event.error !== 'canceled') { ttsIndex += 1; speakNext(); } };
  speechSynthesis.speak(utterance);
}
function speak(text = selected?.text || $('#article').innerText) {
  const selection = selected?.text; stopSpeaking(); ttsForDocument = !selection; ttsQueue = selection ? sentenceQueue(selection) : articleSentenceQueue(); if (!ttsQueue.length) return; if (ttsForDocument) ttsIndex = Math.min(Math.max(0, Number(activeDocument?.ttsSentenceIndex || 0)), ttsQueue.length - 1); speaking = true; $('#ttsToggle').classList.add('active'); speakNext(); clearSelection();
}
function toggleSpeaking() {
  if (!speaking) { speak(); return; }
  if (speechSynthesis.paused || ttsPaused) { ttsPaused = false; speechSynthesis.resume(); return; }
  ttsPaused = true; speechSynthesis.pause();
}
function highlightSearch() {
  $('#article').querySelectorAll('mark.search-hit').forEach((node) => node.replaceWith(document.createTextNode(node.textContent)));
  const term = $('#inDocumentSearch').value.trim(); searchHits=[]; matchIndex=-1; if (!term) { $('#searchCount').textContent=''; return; }
  const walker=document.createTreeWalker($('#article'),NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('mark')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT}); let node; const nodes=[]; while(node=walker.nextNode())nodes.push(node);
  nodes.reverse().forEach((textNode)=>{ const haystack=textNode.nodeValue.toLowerCase(); const needle=term.toLowerCase(); let index=haystack.lastIndexOf(needle); while(index>=0){const after=textNode.splitText(index+term.length);const match=textNode.splitText(index);const mark=document.createElement('mark');mark.className='search-hit';match.parentNode.replaceChild(mark,match);mark.append(match);searchHits.unshift(mark);index=textNode.nodeValue.toLowerCase().lastIndexOf(needle,index-1); if(!after)break;} });
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
  $('#backLibrary').onclick = () => { stopSpeaking(); saveProgress(); showView('library'); refreshLibrary(); };
  $('#searchToggle').onclick = () => { $('#searchBar').hidden = !$('#searchBar').hidden; if(!$('#searchBar').hidden)$('#inDocumentSearch').focus(); };
  $('#closeSearch').onclick = () => { $('#searchBar').hidden=true; $('#inDocumentSearch').value=''; highlightSearch(); }; $('#inDocumentSearch').oninput=highlightSearch; $('#nextMatch').onclick=()=>moveMatch(1); $('#previousMatch').onclick=()=>moveMatch(-1);
  $('#readerSettings').onclick=()=>$('#readingSettings').hidden=!$('#readingSettings').hidden; [['fontSize','--text-size','leaf-font-size','px'],['textWidth','--text-width','leaf-text-width','px'],['lineHeight','--leading','leaf-leading','']].forEach(([id,prop,key,unit])=>$('#'+id).oninput=(event)=>{ $('#article').style.setProperty(prop,event.target.value+unit); localStorage.setItem(key,event.target.value); });
  $('#themeToggle').onclick=()=>document.body.classList.toggle('dark'); $('#ttsToggle').onclick=toggleSpeaking;
  $('#ttsVoice').onchange = (event) => { localStorage.setItem('leaf-tts-voice', event.target.value); if (speaking) { const documentQueue = ttsForDocument; const resumeAt = ttsIndex; const remaining = ttsQueue.slice(ttsIndex); stopSpeaking(false); ttsForDocument = documentQueue; ttsQueue = documentQueue ? articleSentenceQueue() : remaining; ttsIndex = documentQueue ? resumeAt : 0; speaking = true; $('#ttsToggle').classList.add('active'); speakNext(); } };
  $('#ttsRate').value = localStorage.getItem('leaf-tts-rate') || 1; $('#ttsRate').oninput = (event) => { localStorage.setItem('leaf-tts-rate', event.target.value); };
  $('#aiSummary').onclick=async()=>{ if(!activeDocument)return; openAssistant('Reading summary'); try { setAssistantResult(await askAboutDocument('Summarize this reading in 3–5 concise key points, then list important people, events, or ideas and one reading note.')); } catch(error) { setAssistantResult(`Could not reach the AI provider: ${error.message}`, false); } };
  $('#selectionToolbar').onmousedown = (event) => event.preventDefault();
  $('#selectionToolbar').onclick=(event)=>{const action=event.target.closest('button')?.dataset.action;if(!action)return;if(action==='highlight')addHighlight();if(action==='note')openNote();if(action==='word')addWord();if(action==='translate'||action==='explain')aiAction(action);if(action==='speak')speak();};
  $('#closeAssistant').onclick=()=>$('#assistantPanel').hidden=true; $('#followUpForm').onsubmit=async(event)=>{event.preventDefault();const question=$('#followUp').value.trim();if(!question)return;openAssistant('LeafReader AI');try{setAssistantResult(await askAboutDocument(question));}catch(error){setAssistantResult(`Could not reach the AI provider: ${error.message}`, false);}$('#followUp').value='';};
  $('#article').onclick=(event)=>{const mark=event.target.closest('.leaf-note,.leaf-word');if(!mark)return;const item=annotations.find(x=>x.id===mark.dataset.annotationId)||vocabulary.find(x=>x.id===mark.dataset.annotationId);if(item?.note)showToast(item.note);else if(item?.definition){openAssistant('Dictionary');setAssistantResult(item.definition);$('#assistantPanel').hidden=false;}};
}
bind(); populateVoices(); speechSynthesis.onvoiceschanged = populateVoices; loadState().catch((error)=>showToast(`LeafReader could not open its library: ${error.message}`));
