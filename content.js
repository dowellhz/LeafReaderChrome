(() => {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
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
  const host = document.createElement('div');
  host.id = 'leafreader-chrome-root';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host{all:initial}.leaf-root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#26342d}.toolbar{position:fixed;display:flex;align-items:center;gap:2px;padding:4px;background:#293a31;border:1px solid #435649;border-radius:9px;box-shadow:0 8px 26px #0005;z-index:2147483647}.toolbar[hidden],.side[hidden]{display:none}.toolbar button{appearance:none;border:0;border-radius:6px;background:transparent;color:#fff;padding:7px 9px;white-space:nowrap;font:600 12px/1.2 inherit;cursor:pointer}.toolbar button:hover{background:#ffffff1f}.toolbar .star{color:#f5df83}.side{position:fixed;z-index:2147483647;right:18px;top:18px;width:min(390px,calc(100vw - 36px));height:min(680px,calc(100vh - 36px));display:flex;flex-direction:column;background:#fbfaf5;border:1px solid #d8ddd3;border-radius:13px;box-shadow:0 16px 55px #14201840;overflow:hidden}.side header{display:flex;align-items:center;gap:8px;padding:14px 15px;background:#edf2eb;border-bottom:1px solid #d8ddd3}.leaf{color:#3e7256;font-size:21px}.side header strong{font-family:ui-serif,Georgia,serif;font-size:17px;letter-spacing:-.2px}.side header span{font-size:11px;color:#718078;margin-left:auto}.side header button{appearance:none;border:0;background:transparent;border-radius:6px;color:#58685d;font-size:18px;cursor:pointer;padding:3px 6px}.side header button:hover{background:#dce8de}.content{padding:17px;overflow:auto;line-height:1.58;font-size:14px;white-space:pre-wrap}.content h3{font-family:ui-serif,Georgia,serif;font-size:21px;margin:0 0 11px}.content .label{font-size:10px;letter-spacing:1.1px;color:#3e7256;font-weight:700}.content blockquote{margin:11px 0;padding:8px 11px;border-left:3px solid #e2c65e;background:#f5f0df;color:#4c594e;font-family:ui-serif,Georgia,serif}.content textarea{box-sizing:border-box;display:block;width:100%;min-height:118px;margin:12px 0;border:1px solid #d6d9d0;border-radius:8px;padding:10px;resize:vertical;font:inherit}.primary{appearance:none;border:0;border-radius:7px;padding:9px 12px;background:#3e7256;color:#fff;font:650 13px inherit;cursor:pointer}.quiet{appearance:none;border:0;background:transparent;color:#3e7256;font:600 13px inherit;cursor:pointer}.footer{padding:10px 14px;border-top:1px solid #e0e2da;color:#78867c;font-size:11px}.footer button{float:right;border:0;background:none;color:#3e7256;font:600 11px inherit;cursor:pointer}
  </style><div class="leaf-root"><div class="toolbar" hidden><button data-action="translate">翻译</button><button data-action="dictionary">词典</button><button data-action="word">保存单词</button><button data-action="highlight">高亮</button><button data-action="note">笔记</button><button data-action="speak">朗读</button><button data-action="ai" class="star">✦ AI</button></div><aside class="side" hidden><header><b class="leaf">◒</b><strong>LeafReader</strong><span>阅读助手</span><button data-close title="Close">×</button></header><section class="content"></section><footer class="footer">内容仅保存在本机 <button data-open-reader>打开阅读模式 →</button></footer></aside></div>`;
  document.documentElement.append(host);
  const toolbar = shadow.querySelector('.toolbar');
  const side = shadow.querySelector('.side');
  const panel = shadow.querySelector('.content');
  // Enabling is silent: it does not display the side panel. Doing it once on
  // page readiness removes the first-click race between a selection action and
  // Chrome's tab-specific Side Panel setup.
  void sendToExtension({ type:'PREPARE_SIDE_PANEL' });

  const excludedText = 'script,style,noscript,textarea,input,select,option,[contenteditable="true"],#leafreader-chrome-root';
  const textIndex = () => {
    const nodes = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode(node) { return node.parentElement?.closest(excludedText) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    let node; while ((node = walker.nextNode())) nodes.push(node);
    const chars = []; const map = []; let whitespace = false;
    for (const textNode of nodes) for (let offset = 0; offset < textNode.nodeValue.length; offset += 1) {
      const character = textNode.nodeValue[offset];
      if (/\s/.test(character)) { if (!whitespace) { chars.push(' '); map.push({ node: textNode, offset }); whitespace = true; } }
      else { chars.push(character); map.push({ node: textNode, offset }); whitespace = false; }
    }
    return { text: chars.join(''), map };
  };
  const boundaryPosition = (index, node, offset, end = false) => {
    if (node?.nodeType !== Node.TEXT_NODE) return -1;
    if (end) { for (let i = index.map.length - 1; i >= 0; i -= 1) if (index.map[i].node === node && index.map[i].offset < offset) return i + 1; }
    else for (let i = 0; i < index.map.length; i += 1) if (index.map[i].node === node && index.map[i].offset >= offset) return i;
    return -1;
  };
  const createAnchor = (range) => {
    const exact = clean(range?.toString()); if (!exact) return null;
    const index = textIndex(); let start = boundaryPosition(index, range.startContainer, range.startOffset); let end = boundaryPosition(index, range.endContainer, range.endOffset, true);
    if (start < 0 || end <= start) { start = index.text.toLocaleLowerCase().indexOf(exact.toLocaleLowerCase()); end = start < 0 ? -1 : start + exact.length; }
    if (start < 0) return { exact, prefix: '', suffix: '', position: -1 };
    return { exact, prefix: index.text.slice(Math.max(0, start - 80), start), suffix: index.text.slice(end, end + 80), position: start };
  };
  const rangeForAnchor = (anchor) => {
    const exact = clean(anchor?.exact); if (!exact) return null;
    const index = textIndex(); const haystack = index.text.toLocaleLowerCase(); const needle = exact.toLocaleLowerCase(); const candidates = []; let at = haystack.indexOf(needle);
    while (at >= 0) { candidates.push(at); at = haystack.indexOf(needle, at + Math.max(1, needle.length)); }
    if (!candidates.length) return null;
    const best = candidates.sort((left, right) => {
      const score = (position) => (anchor.prefix && index.text.slice(Math.max(0, position - anchor.prefix.length), position) === anchor.prefix ? 10000 : 0) + (anchor.suffix && index.text.slice(position + exact.length, position + exact.length + anchor.suffix.length) === anchor.suffix ? 10000 : 0) - Math.abs(position - Number(anchor.position || 0));
      return score(right) - score(left);
    })[0];
    const first = index.map[best]; const last = index.map[best + exact.length - 1];
    if (!first || !last) return null;
    const range = document.createRange(); range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset + 1); return range;
  };
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
  const paintRecord = (record) => { if (record?.documentId === documentId) paintRange(record, rangeForAnchor(record.anchor)); };
  const restoreRecords = async () => {
    if (!extensionContextIsAlive()) return;
    for (const name of highlightSets.keys()) window.CSS?.highlights?.delete(name);
    highlightSets.clear();
    paintedRanges = [];
    const { annotations = [], vocabulary = [] } = await chrome.storage.local.get(['annotations', 'vocabulary']);
    [...annotations, ...vocabulary].filter((record) => record.documentId === documentId).forEach(paintRecord);
  };
  const display = (title, body, quote = '', extra = {}) => sendToExtension({ type: 'OPEN_LEAF_SIDEPANEL', payload: { mode: 'result', title, body, quote, documentId, documentTitle, context: selectedContext, ...extra } });
  const clearSelection = () => { window.getSelection()?.removeAllRanges(); toolbar.hidden = true; };
  const save = async (key, value) => localStorageCall(async () => { const current = (await chrome.storage.local.get(key))[key] || []; current.push(value); await chrome.storage.local.set({ [key]: current }); });
  const saveWord = async () => localStorageCall(async () => {
    const { vocabulary = [] } = await chrome.storage.local.get('vocabulary'); const lemma = lemmaFor(selectedText); const now = Date.now();
    const existing = vocabulary.find((item) => item.lemma === lemma);
    if (existing) {
      existing.occurrences = Number(existing.occurrences || 1) + 1; existing.lastSeenAt = now; existing.updatedAt = now;
      existing.documentIds = [...new Set([...(existing.documentIds || [existing.documentId].filter(Boolean)), documentId])];
      existing.contexts = [...(existing.contexts || [existing.context].filter(Boolean)), selectedContext].filter(Boolean).slice(-5);
      await chrome.storage.local.set({ vocabulary }); return { record: existing, created: false };
    }
    const record = createRecord('word', { word:selectedText.slice(0,160), lemma, definition:'', occurrences:1, documentIds:[documentId], contexts:[selectedContext], status:'new', intervalDays:0, dueAt:now, reviewCount:0, correctCount:0, lastSeenAt:now });
    vocabulary.push(record); await chrome.storage.local.set({ vocabulary }); return { record, created: true };
  });
  const saveDefinition = async (word, definition) => localStorageCall(async () => {
    const { vocabulary = [] } = await chrome.storage.local.get('vocabulary'); const item = vocabulary.find((candidate) => candidate.lemma === lemmaFor(word));
    if (!item) return; item.definition = definition; item.updatedAt = Date.now(); await chrome.storage.local.set({ vocabulary });
  });
  const createRecord = (kind, extras = {}) => ({ id: `${kind}:${crypto.randomUUID()}`, documentId, documentTitle, quote: selectedText, context: selectedContext, anchor: createAnchor(selectedRange), kind, createdAt: Date.now(), updatedAt: Date.now(), favorite: false, ...extras });
  const showToolbar = () => {
    const selection = window.getSelection(); const text = clean(selection?.toString());
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

  const askAI = async (instruction) => {
    const result = await sendToExtension({ type: 'AI_REQUEST', instruction, text: selectedText, context: selectedContext });
    if (!result?.ok) throw new Error(result?.error || 'Extension background returned no response.');
    return result.content;
  };
  const addVisualHighlight = (record) => { paintRange(record, selectedRange); activeHighlight = record; };
  const saveSelectionMarker = async (kind, extras = {}) => localStorageCall(async () => {
    const { annotations = [] } = await chrome.storage.local.get('annotations');
    const anchor = createAnchor(selectedRange);
    // Retrying the same action should update one marker, not gradually stack
    // identical highlights over the exact same words.
    const existing = annotations.find((record) => record.kind === kind && record.documentId === documentId && record.anchor?.position === anchor?.position && record.anchor?.exact === anchor?.exact);
    if (existing) { Object.assign(existing, extras, { updatedAt:Date.now() }); await chrome.storage.local.set({ annotations }); return existing; }
    const record = createRecord(kind, { anchor, favorite: false, ...extras });
    annotations.push(record); await chrome.storage.local.set({ annotations }); return record;
  });
  async function handleAction(action) {
    if (!selectedText) return;
    // Dictionary lookup is useful for a word or compact phrase. Treat a
    // paragraph-sized accidental lookup as translation so the reader never
    // receives a misleading pronunciation/word-usage card for an article.
    if (action === 'dictionary' && selectedText.length > 160) action = 'translate';
    if (action === 'highlight') { const record=createRecord('highlight'); await save('annotations', record); addVisualHighlight(record); display('Highlight saved', 'This highlight is saved to your LeafReader notes.', selectedText); clearSelection(); return; }
    if (action === 'note') { sendToExtension({ type:'OPEN_LEAF_SIDEPANEL', payload:{ mode:'note', title:'Add a note', quote:selectedText, documentId, documentTitle, context:selectedContext, anchor:createAnchor(selectedRange) } }); clearSelection(); return; }
    if (action === 'word') { const { record, created } = await saveWord(); addVisualHighlight(record); display(created ? 'Saved to vocabulary' : 'Vocabulary updated', created ? '已加入个人词库。点击“词典”可用 AI 补全中文释义；词条会在复习页按间隔重复出现。' : `已记录第 ${record.occurrences} 次出现，并保留新的阅读上下文。`, selectedText); clearSelection(); return; }
    if (action === 'speak') { speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(selectedText);utterance.lang=/[\u3400-\u9fff]/.test(selectedText)?'zh-CN':'en-US';speechSynthesis.speak(utterance);display('Read aloud','LeafReader is reading the selected text aloud.',selectedText);clearSelection();return; }
    if (action === 'dictionary') {
      const conversationId = crypto.randomUUID(); const marker = await saveSelectionMarker('dictionary', { conversationId, presentation:'dictionary' }); addVisualHighlight(marker);
      display('单词释义', '正在按上下文解释…', selectedText, { conversationId, presentation:'dictionary' });
      try {
        const answer = await askAI('Explain this English word or short phrase for a Chinese learner. Use concise Markdown with these sections: ## 发音 (UK and US IPA if known), one-line contextual Chinese meaning, ## 常见用法 (1–3 natural English examples with Chinese explanations), and ## 词性. Explain the selected text in its reading context; do not write a long essay.');
        await saveDefinition(selectedText, answer); display('单词释义', answer, selectedText, { conversationId, presentation:'dictionary' });
      } catch (_) {
        // AI is optional. Keep a useful no-key fallback, but make its limitation explicit.
        try { const response=await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(selectedText)}`);if(!response.ok)throw new Error();const [entry]=await response.json();const definitions=(entry.meanings||[]).slice(0,3).map((meaning)=>`${meaning.partOfSpeech}: ${meaning.definitions?.[0]?.definition||''}`).join('\n');const fallback=`AI 未配置或不可用，以下为英文词典释义。\n${entry.phonetic || ''}\n${definitions}`;await saveDefinition(selectedText,fallback);display(entry.word || 'English dictionary',fallback,selectedText,{ conversationId, presentation:'dictionary' });} catch (_) {display('单词释义','AI 未配置或不可用，且没有找到在线英文词典条目。请检查 AI 设置，或选择单个英文单词。',selectedText,{ conversationId, presentation:'dictionary' });}
      }
      clearSelection(); return;
    }
    const conversationId = crypto.randomUUID(); const kind = action === 'translate' ? 'translation' : 'explanation'; const marker = await saveSelectionMarker(kind, { conversationId, presentation:'chat' }); addVisualHighlight(marker);
    const title=action === 'translate' ? 'Translation' : 'AI explanation';display(title,'Thinking…',selectedText,{ conversationId });try { const instruction=action === 'translate' ? 'Translate every sentence in the selected text completely and in order. Do not summarize, omit, or explain only selected keywords. Preserve paragraph breaks. Return only the translation unless a brief clarification is essential.' : 'Explain the meaning in context, useful vocabulary or grammar, and the author’s likely intent.';display(title,await askAI(instruction),selectedText,{ conversationId });} catch(error) {display(title,`Could not reach the AI provider: ${error.message}`,selectedText,{ conversationId });}clearSelection();
  }
  const startToolbarAction = async (action) => {
    if (!action) return;
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
    const title = { translation:'Translation', dictionary:'单词释义', explanation:'AI explanation', note:'Note', word:'Vocabulary', highlight:'Highlight' }[record.kind] || 'LeafReader';
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
    if (location.href !== observedUrl) refreshIdentity();
    clearTimeout(restoreTimer); restoreTimer = setTimeout(() => restoreRecords().catch(() => {}), 900);
  });
  observer.observe(document.body, { childList:true, subtree:true, characterData:true });
  const refreshIdentity = () => { if (location.href !== observedUrl) { observedUrl = location.href; documentId = `web:${location.href}`; documentTitle = clean(document.querySelector('meta[property="og:title"]')?.content || document.title || location.hostname); void sendToExtension({ type:'PAGE_CHANGED' }); void restoreRecords(); } };
  addEventListener('popstate', refreshIdentity); addEventListener('hashchange', refreshIdentity);
})();
