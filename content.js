(() => {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const cleanSelection = LeafTranslation.normalizeSelectionText;
  const preferredTtsLanguage = LeafTts.preferredLanguage;
  const lemmaFor = (value) => {
    const word = clean(value).toLocaleLowerCase().replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, '');
    if (!/^[a-z][a-z'-]*$/i.test(word)) return word;
    if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
    if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3).replace(/([b-df-hj-np-tv-z])\1$/, '$1');
    if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2).replace(/([b-df-hj-np-tv-z])\1$/, '$1');
    if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
    if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
  };
  const extensionContextIsAlive = () => {
    try { return Boolean(chrome?.runtime?.id); } catch (_) { return false; }
  };
  const sendToExtension = (message) => {
    if (!extensionContextIsAlive()) return Promise.resolve({ ok: false, contextInvalidated: true });
    return chrome.runtime.sendMessage(message).catch((error) => {
      if (/Extension context invalidated/i.test(error?.message || '')) return { ok: false, contextInvalidated: true };
      throw error;
    });
  };
  const localStorageCall = async (callback) => {
    if (!extensionContextIsAlive()) throw new Error('LeafReader was updated. Refresh this webpage, then try again.');
    return callback();
  };
  const mutateStorage = async (mutation) => {
    const result = await sendToExtension({ type:'STORAGE_MUTATION', mutation });
    if (!result?.ok) throw new Error(result?.error || 'LeafReader could not save local data.');
    return result;
  };
  const ignored = 'script,style,noscript,nav,aside,footer,header,form,button,iframe,svg,canvas,[aria-hidden="true"],.advertisement,.ads,.ad';
  const visibleText = (element) => clean(element?.innerText || element?.textContent);
  function score(element) {
    const text = visibleText(element);
    if (text.length < 180) return -Infinity;
    const links = [...element.querySelectorAll('a')].reduce((n, a) => n + visibleText(a).length, 0);
    const punctuation = (text.match(/[.!?。！？]/g) || []).length;
    return text.length * (1 - Math.min(0.8, links / text.length)) + punctuation * 35;
  }
  function capture() {
    const candidates = [...document.querySelectorAll('article,main,[role="main"],.post,.article,.entry-content,.content')];
    const root = candidates.sort((a, b) => score(b) - score(a))[0] || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll(ignored).forEach((node) => node.remove());
    clone.querySelectorAll('img').forEach((image) => {
      const src = image.currentSrc || image.src;
      if (src) image.setAttribute('src', src);
      image.removeAttribute('srcset');
    });
    clone.querySelectorAll('a').forEach((link) => link.setAttribute('href', link.href || '#'));
    const title = clean(document.querySelector('meta[property="og:title"]')?.content || document.title || location.hostname);
    return { id: `web:${location.href}`, sourceUrl: location.href, title, byline: clean(document.querySelector('[rel="author"],.author,[class*="byline"]')?.textContent), html: clone.innerHTML, text: visibleText(clone), capturedAt: Date.now() };
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'CAPTURE_ARTICLE') respond(capture());
    if (message.type === 'ANNOTATION_SAVED') { paintRecord(message.record); respond({ ok: true }); }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'r') {
      event.preventDefault(); sendToExtension({ type: 'OPEN_READER' });
    }
  });

  // Web-page companion: the UI is isolated in a shadow root so it never inherits
  // (or changes) a site's CSS. It mirrors LeafReader's selection-first workflow.
  let documentId = `web:${location.href}`;
  let documentTitle = clean(document.querySelector('meta[property="og:title"]')?.content || document.title || location.hostname);
  let observedUrl = location.href;
  let selectedText = '';
  let selectedContext = '';
  let selectedRange = null;
  let activeHighlight = null;
  const highlightSets = new Map();
  let paintedRanges = [];
  let ttsPreferences = { voices: {}, rate: 1, pitch: 1, localOnly: true };
  let contentVoicesPromise = null;
  const contentTtsState = LeafTts.createPlaybackState();
  void chrome.storage.local.get('ttsPreferences').then((data) => { if (data.ttsPreferences) ttsPreferences = { ...ttsPreferences, ...data.ttsPreferences, voices:{ ...(data.ttsPreferences.voices || {}) } }; });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.ttsPreferences?.newValue) ttsPreferences = { ...ttsPreferences, ...changes.ttsPreferences.newValue, voices:{ ...(changes.ttsPreferences.newValue.voices || {}) } }; });
  const host = document.createElement('div');
  host.id = 'leafreader-chrome-root';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host{all:initial}.leaf-root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#26342d}.toolbar{position:fixed;display:flex;align-items:center;gap:2px;padding:4px;background:rgb(41 58 49 / .55);border:1px solid rgb(179 202 185 / .42);border-radius:9px;box-shadow:0 8px 26px #0004;backdrop-filter:blur(9px);z-index:2147483647}.toolbar[hidden],.side[hidden],.tts-player[hidden]{display:none}.toolbar button{appearance:none;border:0;border-radius:6px;background:transparent;color:#fff;padding:7px 9px;white-space:nowrap;font:600 12px/1.2 inherit;cursor:pointer}.toolbar button:hover{background:#ffffff1f}.toolbar .star{color:#f5df83}.side{position:fixed;z-index:2147483647;right:18px;top:18px;width:min(390px,calc(100vw - 36px));height:min(680px,calc(100vh - 36px));display:flex;flex-direction:column;background:#fbfaf5;border:1px solid #d8ddd3;border-radius:13px;box-shadow:0 16px 55px #14201840;overflow:hidden}.side header{display:flex;align-items:center;gap:8px;padding:14px 15px;background:#edf2eb;border-bottom:1px solid #d8ddd3}.leaf{color:#3e7256;font-size:21px}.side header strong{font-family:ui-serif,Georgia,serif;font-size:17px;letter-spacing:-.2px}.side header span{font-size:11px;color:#718078;margin-left:auto}.side header button{appearance:none;border:0;background:transparent;border-radius:6px;color:#58685d;font-size:18px;cursor:pointer;padding:3px 6px}.side header button:hover{background:#dce8de}.content{padding:17px;overflow:auto;line-height:1.58;font-size:14px;white-space:pre-wrap}.content h3{font-family:ui-serif,Georgia,serif;font-size:21px;margin:0 0 11px}.content .label{font-size:10px;letter-spacing:1.1px;color:#3e7256;font-weight:700}.content blockquote{margin:11px 0;padding:8px 11px;border-left:3px solid #e2c65e;background:#f5f0df;color:#4c594e;font-family:ui-serif,Georgia,serif}.content textarea{box-sizing:border-box;display:block;width:100%;min-height:118px;margin:12px 0;border:1px solid #d6d9d0;border-radius:8px;padding:10px;resize:vertical;font:inherit}.primary{appearance:none;border:0;border-radius:7px;padding:9px 12px;background:#3e7256;color:#fff;font:650 13px inherit;cursor:pointer}.quiet{appearance:none;border:0;background:transparent;color:#3e7256;font:600 13px inherit;cursor:pointer}.footer{padding:10px 14px;border-top:1px solid #e0e2da;color:#78867c;font-size:11px}.footer button{float:right;border:0;background:none;color:#3e7256;font:600 11px inherit;cursor:pointer}.tts-player{position:fixed;left:18px;bottom:18px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:7px 9px 7px 12px;border:1px solid rgb(179 202 185 / .42);border-radius:10px;background:rgb(41 58 49 / .55);backdrop-filter:blur(9px);color:#fff;box-shadow:0 8px 26px #0004;font:600 12px/1.2 inherit}.tts-player button{appearance:none;border:0;border-radius:6px;background:#ffffff18;color:#fff;padding:6px 9px;font:600 12px/1 inherit;cursor:pointer}.tts-player button:hover{background:#ffffff2c}
    .toolbar{background:rgb(41 58 49 / .30);border-color:rgb(196 215 200 / .30);box-shadow:0 8px 26px #0003;backdrop-filter:blur(7px)}.tts-player{background:rgb(41 58 49 / .30);border-color:rgb(196 215 200 / .30);box-shadow:0 8px 26px #0003;backdrop-filter:blur(7px)}
  </style><div class="leaf-root"><div class="toolbar" hidden><button data-action="translate">翻译</button><button data-action="word">单词</button><button data-action="note">笔记</button><button data-action="speak">朗读</button><button data-action="ai" class="star">✦ 讲解</button></div><aside class="side" hidden><header><b class="leaf">◒</b><strong>LeafReader</strong><span>阅读助手</span><button data-close title="Close">×</button></header><section class="content"></section><footer class="footer">内容仅保存在本机 <button data-open-reader>打开阅读模式 →</button></footer></aside><div class="tts-player" hidden role="status" aria-live="polite"><span data-tts-status>正在朗读</span><button data-tts-toggle>暂停</button><button data-tts-stop title="停止朗读">停止</button></div></div>`;
  document.documentElement.append(host);
  const toolbar = shadow.querySelector('.toolbar');
  const side = shadow.querySelector('.side');
  const panel = shadow.querySelector('.content');
  const ttsPlayer = shadow.querySelector('.tts-player');
  const ttsStatus = shadow.querySelector('[data-tts-status]');
  const ttsToggle = shadow.querySelector('[data-tts-toggle]');
  // Enabling is silent: it does not display the side panel. Doing it once on
  // page readiness removes the first-click race between a selection action and
  // Chrome's tab-specific Side Panel setup.
  void sendToExtension({ type:'PREPARE_SIDE_PANEL' });

  const excludedText = 'script,style,noscript,textarea,input,select,option,[contenteditable="true"],#leafreader-chrome-root';
  let textIndexVersion = 0;
  let cachedTextIndex = null;
  let cachedTextIndexVersion = -1;
  const textIndex = () => {
    if (!cachedTextIndex || cachedTextIndexVersion !== textIndexVersion) {
      cachedTextIndex = LeafAnchor.buildTextIndex(document.body, excludedText);
      cachedTextIndexVersion = textIndexVersion;
    }
    return cachedTextIndex;
  };
  const createAnchor = (range) => {
    return LeafAnchor.createAnchor(range, textIndex());
  };
  const rangeForAnchor = (anchor, index = textIndex()) => LeafAnchor.rangeForAnchor(anchor, index, document);
  const paintRange = (record, range) => {
    if (!range || !window.CSS?.highlights || !window.Highlight) return;
    const name = {
      note: 'leafreader-page-note',
      word: 'leafreader-page-word',
      translation: 'leafreader-page-translation',
      dictionary: 'leafreader-page-dictionary',
      explanation: 'leafreader-page-explanation'
    }[record.kind] || 'leafreader-page-highlight';
    const set = highlightSets.get(name) || new Highlight(); set.add(range); highlightSets.set(name, set); window.CSS.highlights.set(name, set);
    paintedRanges.push({ record, range });
  };
  const recordBelongsToDocument = (record) => record?.documentId === documentId || record?.documentIds?.includes(documentId);
  const recordAnchor = (record) => record?.anchors?.[documentId] || record?.anchor || (record?.quote || record?.word ? { exact:record.quote || record.word, position:record?.locator?.position || 0 } : null);
  const paintRecord = (record, index = textIndex()) => { if (recordBelongsToDocument(record)) paintRange(record, rangeForAnchor(recordAnchor(record), index)); };
  let restoreGeneration = 0;
  const yieldForPainting = () => new Promise((resolve) => (globalThis.requestIdleCallback ? requestIdleCallback(resolve, { timeout:120 }) : setTimeout(resolve, 0)));
  const restoreRecords = async () => {
    if (!extensionContextIsAlive()) return;
    const generation = ++restoreGeneration;
    for (const name of highlightSets.keys()) window.CSS?.highlights?.delete(name);
    highlightSets.clear();
    paintedRanges = [];
    const { annotations = [], vocabulary = [] } = await chrome.storage.local.get(['annotations', 'vocabulary']);
    if (generation !== restoreGeneration) return;
    const index = textIndex();
    const records = [...annotations, ...vocabulary].filter(recordBelongsToDocument);
    for (let offset = 0; offset < records.length; offset += 40) {
      if (generation !== restoreGeneration) return;
      records.slice(offset, offset + 40).forEach((record) => paintRecord(record, index));
      if (offset + 40 < records.length) await yieldForPainting();
    }
  };
  const display = (title, body, quote = '', extra = {}) => sendToExtension({ type: 'OPEN_LEAF_SIDEPANEL', payload: { mode: 'result', title, body, quote, documentId, documentTitle, context: selectedContext, ...extra } });
  const clearSelection = () => { window.getSelection()?.removeAllRanges(); toolbar.hidden = true; };
  const saveWord = async (extras = {}) => localStorageCall(async () => {
    const lemma = lemmaFor(selectedText); const now = Date.now();
    const record = createRecord('word', { word:selectedText.slice(0,160), lemma, definition:'', occurrences:1, documentIds:[documentId], contexts:[selectedContext], anchors:{ [documentId]:createAnchor(selectedRange) }, status:'new', intervalDays:0, dueAt:now, reviewCount:0, correctCount:0, lastSeenAt:now, ...extras });
    return mutateStorage({ operation:'saveVocabulary', record });
  });
  const saveDefinition = async (word, definition, extras = {}) => localStorageCall(() => mutateStorage({ operation:'patchVocabularyByLemma', lemma:lemmaFor(word), changes:{ definition, ...extras } }));
  const createRecord = (kind, extras = {}) => ({ id: `${kind}:${crypto.randomUUID()}`, documentId, documentTitle, quote: selectedText, context: selectedContext, anchor: createAnchor(selectedRange), kind, createdAt: Date.now(), updatedAt: Date.now(), favorite: false, ...extras });
  const showToolbar = () => {
    const selection = window.getSelection(); const text = cleanSelection(selection?.toString());
    if (!text || selection.rangeCount === 0 || text.length > 2500 || selection.anchorNode?.parentElement?.closest?.('input,textarea,[contenteditable="true"]')) { toolbar.hidden = true; return; }
    const range = selection.getRangeAt(0); if (!document.body.contains(range.commonAncestorContainer)) return;
    selectedText = text; selectedRange = range.cloneRange(); selectedContext = clean(range.commonAncestorContainer.parentElement?.closest('p,li,blockquote,article,main,div')?.innerText || '').slice(0, 500);
    const rect = range.getBoundingClientRect(); toolbar.style.left = `${Math.max(9, Math.min(innerWidth - 390, rect.left + rect.width / 2 - 138))}px`; toolbar.style.top = `${Math.max(9, rect.top - 46)}px`; toolbar.hidden = false;
  };
  let selectionTimer = 0;
  const scheduleToolbar = () => { clearTimeout(selectionTimer); selectionTimer = setTimeout(showToolbar, 80); };
  // Capture phase survives pages that stop propagation on mouseup. The
  // selectionchange fallback also covers double-click and keyboard selection.
  document.addEventListener('mouseup', scheduleToolbar, true);
  document.addEventListener('selectionchange', scheduleToolbar);
  document.addEventListener('keyup', (event) => { if (event.key === 'Escape') { toolbar.hidden = true; return; } if (event.shiftKey || ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) scheduleToolbar(); });
  toolbar.addEventListener('mousedown', (event) => event.preventDefault());
  shadow.querySelector('[data-close]').onclick = () => side.hidden = true;
  shadow.querySelector('[data-open-reader]').onclick = () => sendToExtension({ type: 'OPEN_READER' });

  const askAI = async (instruction, text = selectedText) => {
    const result = await sendToExtension({ type: 'AI_REQUEST', instruction, text, context: selectedContext });
    if (!result?.ok) throw new Error(result?.error || 'Extension background returned no response.');
    return result.content;
  };
  const voiceForLanguage = (language) => {
    const key = LeafTts.languageKey(language); return LeafTts.selectVoice(speechSynthesis.getVoices(), language, ttsPreferences.voices?.[key], ttsPreferences.localOnly);
  };
  const ensureTtsVoices = (timeoutMs = 1800) => {
    if (speechSynthesis.getVoices().length) return Promise.resolve(speechSynthesis.getVoices());
    if (!contentVoicesPromise) contentVoicesPromise = new Promise((resolve) => {
      let timer = 0;
      const finish = () => { clearTimeout(timer); speechSynthesis.removeEventListener('voiceschanged', changed); contentVoicesPromise = null; resolve(speechSynthesis.getVoices()); };
      const changed = () => { if (speechSynthesis.getVoices().length) finish(); };
      speechSynthesis.addEventListener('voiceschanged', changed); timer = setTimeout(finish, timeoutMs);
    });
    return contentVoicesPromise;
  };
  const selectionSpeechChunks = (text) => LeafTts.chunkText(text, 320);
  let contentTtsQueue = [];
  let contentTtsIndex = 0;
  let contentUtteranceActive = false;
  const setSelectionSpeechHighlight = (range) => {
    if (!window.CSS?.highlights || !window.Highlight) return;
    if (range) window.CSS.highlights.set('leafreader-page-tts', new Highlight(range));
    else window.CSS.highlights.delete('leafreader-page-tts');
  };
  const stopSelectionSpeech = () => { const generation = contentTtsState.cancel(); contentTtsQueue = []; contentTtsIndex = 0; contentUtteranceActive = false; speechSynthesis.cancel(); setSelectionSpeechHighlight(null); ttsPlayer.hidden = true; ttsToggle.hidden = false; ttsToggle.textContent = '暂停'; return generation; };
  const speakNextSelectionChunk = (generation) => {
    if (!contentTtsState.isCurrent(generation) || contentTtsState.paused || contentTtsIndex >= contentTtsQueue.length) return;
    const item = contentTtsQueue[contentTtsIndex];
    const utterance = new SpeechSynthesisUtterance(item.spokenText); utterance.lang = item.voice?.lang || item.language; utterance.rate = Math.min(1.5, Math.max(.7, Number(ttsPreferences.rate) || 1)); utterance.pitch = Math.min(1.2, Math.max(.8, Number(ttsPreferences.pitch) || 1)); if (item.voice) utterance.voice = item.voice;
    ttsStatus.textContent = `正在朗读${item.voice?.name ? ` · ${item.voice.name}` : ''}`;
    contentUtteranceActive = true;
    utterance.onend = () => {
      if (!contentTtsState.isCurrent(generation)) return;
      contentUtteranceActive = false; contentTtsIndex += 1;
      const result = contentTtsState.complete(generation);
      if (result.done) { setSelectionSpeechHighlight(null); ttsPlayer.hidden = true; return; }
      speakNextSelectionChunk(generation);
    };
    utterance.onerror = (event) => {
      if (!contentTtsState.isCurrent(generation)) return;
      contentUtteranceActive = false;
      if (['interrupted','canceled'].includes(event.error)) return;
      const failureGeneration = contentTtsState.fail(generation); speechSynthesis.cancel(); setSelectionSpeechHighlight(null); ttsStatus.textContent = `朗读错误：${event.error || 'unknown'}`; ttsToggle.hidden = true; ttsPlayer.hidden = false; setTimeout(() => { if (contentTtsState.isCurrent(failureGeneration)) ttsPlayer.hidden = true; }, 4000);
    };
    speechSynthesis.speak(utterance);
  };
  const toggleSelectionSpeech = () => { if (!contentTtsState.remaining) return; if (speechSynthesis.paused || contentTtsState.paused) { contentTtsState.resume(); speechSynthesis.resume(); ttsToggle.textContent = '暂停'; ttsStatus.textContent = '正在朗读'; if (!contentUtteranceActive) speakNextSelectionChunk(contentTtsState.generation); } else { contentTtsState.pause(); speechSynthesis.pause(); ttsToggle.textContent = '继续'; ttsStatus.textContent = '已暂停'; } };
  const speakSelection = async () => {
    const text = selectedText; const speechRange = selectedRange?.cloneRange(); const waitingGeneration = stopSelectionSpeech(); await ensureTtsVoices(); if (!contentTtsState.isCurrent(waitingGeneration)) return { ok:false, canceled:true };
    const chunks = selectionSpeechChunks(text); contentTtsQueue = chunks.map((chunk) => ({ ...chunk, spokenText:LeafTts.speechText(chunk.text, chunk.language), voice:voiceForLanguage(chunk.language) })).filter((item) => item.spokenText); const missing = contentTtsQueue.find((item) => !item.voice);
    if (ttsPreferences.localOnly && missing) { contentTtsQueue = []; return { ok:false, language:missing.language }; }
    if (!contentTtsQueue.length) return { ok:false }; contentTtsIndex = 0; const generation = contentTtsState.begin(contentTtsQueue.length); setSelectionSpeechHighlight(speechRange);
    ttsPlayer.hidden = false; ttsToggle.hidden = false; ttsStatus.textContent = '正在朗读'; ttsToggle.textContent = '暂停';
    speakNextSelectionChunk(generation);
    return { ok:true };
  };
  ttsToggle.onclick = toggleSelectionSpeech;
  shadow.querySelector('[data-tts-stop]').onclick = stopSelectionSpeech;
  addEventListener('pagehide', stopSelectionSpeech);
  const addVisualHighlight = (record) => { paintRange(record, selectedRange); activeHighlight = record; };
  const saveSelectionMarker = async (kind, extras = {}) => localStorageCall(async () => {
    const anchor = createAnchor(selectedRange);
    const record = createRecord(kind, { anchor, favorite: false, ...extras });
    return (await mutateStorage({ operation:'upsertAnnotationMarker', record })).record;
  });
  async function handleAction(action) {
    if (!selectedText) return;
    // Dictionary lookup is useful for a word or compact phrase. Treat a
    // paragraph-sized accidental lookup as translation so the reader never
    // receives a misleading pronunciation/word-usage card for an article.
    if (action === 'word' && selectedText.length > 160) action = 'translate';
    if (action === 'note') { sendToExtension({ type:'OPEN_LEAF_SIDEPANEL', payload:{ mode:'note', title:'Add a note', quote:selectedText, documentId, documentTitle, context:selectedContext, anchor:createAnchor(selectedRange) } }); clearSelection(); return; }
    if (action === 'speak') { const spoken = await speakSelection(); if (spoken.canceled) return; if (!spoken.ok) { ttsStatus.textContent = `没有可用的本地 ${spoken.language || ''} 语音`; ttsToggle.hidden = true; ttsPlayer.hidden = false; setTimeout(() => { ttsPlayer.hidden = true; }, 4000); } clearSelection(); return; }
    if (action === 'word') {
      const conversationId = crypto.randomUUID();
      const { record } = await saveWord({ conversationId, presentation:'dictionary' }); addVisualHighlight(record);
      display('单词释义', '正在按上下文解释…', selectedText, { conversationId, presentation:'dictionary' });
      try {
        const answer = await askAI('Explain this English word or short phrase for a Chinese learner. Use concise Markdown with these sections: ## 发音 (UK and US IPA if known), one-line contextual Chinese meaning, ## 常见用法 (1–3 natural English examples with Chinese explanations), and ## 词性. Explain the selected text in its reading context; do not write a long essay.');
        await saveDefinition(selectedText, answer, { conversationId, presentation:'dictionary' }); display('单词释义', answer, selectedText, { conversationId, presentation:'dictionary' });
      } catch (_) {
        // AI is optional. Keep a useful no-key fallback, but make its limitation explicit.
        try { const response=await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(selectedText)}`);if(!response.ok)throw new Error();const [entry]=await response.json();const definitions=(entry.meanings||[]).slice(0,3).map((meaning)=>`${meaning.partOfSpeech}: ${meaning.definitions?.[0]?.definition||''}`).join('\n');const fallback=`AI 未配置或不可用，以下为英文词典释义。\n${entry.phonetic || ''}\n${definitions}`;await saveDefinition(selectedText,fallback,{ conversationId, presentation:'dictionary' });display(entry.word || 'English dictionary',fallback,selectedText,{ conversationId, presentation:'dictionary' });} catch (_) {display('单词释义','AI 未配置或不可用，且没有找到在线英文词典条目。请检查 AI 设置，或选择单个英文单词。',selectedText,{ conversationId, presentation:'dictionary' });}
      }
      clearSelection(); return;
    }
    const conversationId = crypto.randomUUID(); const kind = action === 'translate' ? 'translation' : 'explanation'; const marker = await saveSelectionMarker(kind, { conversationId, presentation:'chat' }); addVisualHighlight(marker);
    const title=action === 'translate' ? 'Translation' : '讲解';display(title,'Thinking…',selectedText,{ conversationId });try { let answer; if (action === 'translate') { const prepared=LeafTranslation.prepareParagraphTranslation(selectedText); const instruction=prepared.count > 1 ? `Translate every sentence in the selected text completely and in order. The input has ${prepared.count} paragraphs labeled [[P1]] through [[P${prepared.count}]]. Keep every label unchanged and in the same order, translate each paragraph separately, and put one blank line between labeled paragraphs. Do not merge, summarize, omit, or add commentary.` : 'Translate every sentence in the selected text completely and in order. Do not summarize, omit, or add commentary. Return only the translation.'; answer=LeafTranslation.restoreParagraphTranslation(await askAI(instruction,prepared.text),prepared.count); } else answer=await askAI('Explain the meaning in context, useful vocabulary or grammar, and the author’s likely intent.'); display(title,answer,selectedText,{ conversationId });} catch(error) {display(title,`Could not reach the AI provider: ${error.message}`,selectedText,{ conversationId });}clearSelection();
  }
  const startToolbarAction = async (action) => {
    if (!action) return;
    refreshIdentity();
    // Read-aloud stays entirely on the webpage: it uses the compact playback
    // controls and never opens or adds a response to the native Side Panel.
    if (action === 'speak') {
      handleAction(action).catch((error) => {
        ttsStatus.textContent = `朗读错误：${error.message}`;
        ttsToggle.hidden = true;
        ttsPlayer.hidden = false;
        setTimeout(() => { ttsPlayer.hidden = true; }, 4000);
      });
      return;
    }
    // Do this synchronously from pointerdown. Chrome only permits
    // sidePanel.open() while the content-script user gesture is live.
    const opened = await sendToExtension({ type:'OPEN_LEAF_SIDEPANEL', open:true, payload:{ mode:'result', title:'LeafReader', body:'Loading…', quote:selectedText, documentId, documentTitle, context:selectedContext } });
    if (!opened?.ok) { toolbar.hidden = false; return; }
    handleAction(action).catch((error) => display('LeafReader error', `The selected action could not finish: ${error.message}`, selectedText));
  };
  toolbar.addEventListener('pointerdown', (event) => {
    const action = event.target.dataset.action;
    if (!action) return;
    event.preventDefault();
    void startToolbarAction(action);
  });
  toolbar.addEventListener('click', (event) => event.preventDefault());
  const rangeAtPoint = (x, y) => document.caretRangeFromPoint?.(x, y) || (() => {
    const position = document.caretPositionFromPoint?.(x, y);
    if (!position) return null;
    const range = document.createRange(); range.setStart(position.offsetNode, position.offset); range.collapse(true); return range;
  })();
  const openMarkedRecord = (record) => {
    const title = { translation:'Translation', dictionary:'单词释义', explanation:'讲解', note:'Note', word:'单词释义', highlight:'Highlight' }[record.kind] || 'LeafReader';
    const payload = { mode:'result', title, body:record.note || record.definition || 'Saved webpage marker.', quote:record.quote || record.word || '', context:record.context || '', documentId, documentTitle, presentation:record.presentation || (record.kind === 'dictionary' ? 'dictionary' : 'chat') };
    if (record.conversationId) Object.assign(payload, { conversationId:record.conversationId, restoreThread:true });
    void sendToExtension({ type:'OPEN_LEAF_SIDEPANEL', open:true, payload });
  };
  document.addEventListener('click', (event) => {
    if (event.button !== 0 || !window.getSelection()?.isCollapsed) return;
    const point = rangeAtPoint(event.clientX, event.clientY); if (!point) return;
    const hit = [...paintedRanges].reverse().find(({ range }) => { try { return range.isPointInRange(point.startContainer, point.startOffset); } catch (_) { return false; } });
    if (!hit) return;
    event.preventDefault(); event.stopImmediatePropagation(); openMarkedRecord(hit.record);
  }, true);
  restoreRecords().catch(() => {});
  let restoreTimer = 0;
  const observer = new MutationObserver((changes) => {
    if (!changes.some((change) => !host.contains(change.target))) return;
    textIndexVersion += 1;
    if (location.href !== observedUrl) refreshIdentity();
    clearTimeout(restoreTimer); restoreTimer = setTimeout(() => restoreRecords().catch(() => {}), 1200);
  });
  observer.observe(document.body, { childList:true, subtree:true, characterData:true });
  const refreshIdentity = () => { if (location.href !== observedUrl) { observedUrl = location.href; documentId = `web:${location.href}`; documentTitle = clean(document.querySelector('meta[property="og:title"]')?.content || document.title || location.hostname); void sendToExtension({ type:'PAGE_CHANGED' }); void restoreRecords(); } };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.annotations || changes.vocabulary)) {
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => restoreRecords().catch(() => {}), 120);
    }
  });
  addEventListener('popstate', refreshIdentity); addEventListener('hashchange', refreshIdentity);
})();
