const READER_URL = chrome.runtime.getURL('reader.html');
const RECORD_STORAGE_KEYS = new Set(['annotations', 'vocabulary']);
let storageMutationQueue = Promise.resolve();

function enqueueStorageMutation(task) {
  const result = storageMutationQueue.then(task, task);
  storageMutationQueue = result.catch(() => {});
  return result;
}

function storageRecordKey(value) {
  const key = String(value || '');
  if (!RECORD_STORAGE_KEYS.has(key)) throw new Error('Unsupported record collection.');
  return key;
}

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

async function mutateStorage(mutation) {
  const operation = String(mutation?.operation || '');
  if (operation === 'addRecord') {
    const key = storageRecordKey(mutation.key);
    const record = objectValue(mutation.record, 'Record');
    if (!record.id) throw new Error('Record id is required.');
    const data = await chrome.storage.local.get(key);
    const records = Array.isArray(data[key]) ? data[key] : [];
    const index = records.findIndex((item) => item?.id === record.id);
    if (index >= 0) records[index] = { ...records[index], ...record };
    else records.push(record);
    await chrome.storage.local.set({ [key]:records });
    return { record, records };
  }
  if (operation === 'upsertAnnotationMarker') {
    const record = objectValue(mutation.record, 'Annotation');
    if (!record.id || !record.documentId || !record.kind) throw new Error('Annotation id, document, and kind are required.');
    const { annotations:stored = [] } = await chrome.storage.local.get('annotations');
    const annotations = Array.isArray(stored) ? stored : [];
    const existing = annotations.find((item) => item?.kind === record.kind
      && item?.documentId === record.documentId
      && item?.anchor?.position === record.anchor?.position
      && item?.anchor?.exact === record.anchor?.exact);
    if (existing) Object.assign(existing, record, { id:existing.id, createdAt:existing.createdAt, updatedAt:Date.now() });
    else annotations.push(record);
    await chrome.storage.local.set({ annotations });
    return { record:existing || record, records:annotations, created:!existing };
  }
  if (operation === 'patchRecord' || operation === 'toggleFavorite' || operation === 'reviewVocabulary' || operation === 'markVocabularyKnown') {
    const key = operation.includes('Vocabulary') ? 'vocabulary' : storageRecordKey(mutation.key);
    const id = String(mutation.id || '');
    const data = await chrome.storage.local.get(key);
    const records = Array.isArray(data[key]) ? data[key] : [];
    const record = records.find((item) => item?.id === id);
    if (!record) throw new Error('Record no longer exists.');
    if (operation === 'patchRecord') {
      const changes = { ...objectValue(mutation.changes, 'Record changes') };
      delete changes.id;
      Object.assign(record, changes, { updatedAt:Date.now() });
    } else if (operation === 'toggleFavorite') {
      record.favorite = !record.favorite;
      record.updatedAt = Date.now();
    } else if (operation === 'markVocabularyKnown') {
      record.status = 'known';
      record.dueAt = Date.now() + 30 * 86400000;
      record.intervalDays = 30;
      record.updatedAt = Date.now();
    } else {
      const correct = Boolean(mutation.correct);
      record.reviewCount = Number(record.reviewCount || 0) + 1;
      record.correctCount = Number(record.correctCount || 0) + (correct ? 1 : 0);
      record.intervalDays = correct ? Math.min(90, Math.max(1, Math.round((record.intervalDays || 0) * 2.4) || 1)) : 1;
      record.status = correct ? 'learning' : 'new';
      record.dueAt = Date.now() + record.intervalDays * 86400000;
      record.updatedAt = Date.now();
    }
    await chrome.storage.local.set({ [key]:records });
    return { record, records };
  }
  if (operation === 'removeRecord') {
    const key = storageRecordKey(mutation.key);
    const data = await chrome.storage.local.get(key);
    const records = (Array.isArray(data[key]) ? data[key] : []).filter((item) => item?.id !== mutation.id);
    await chrome.storage.local.set({ [key]:records });
    return { records };
  }
  if (operation === 'saveVocabulary') {
    const candidate = objectValue(mutation.record, 'Vocabulary record');
    if (!candidate.id || !candidate.lemma) throw new Error('Vocabulary id and lemma are required.');
    const { vocabulary:stored = [] } = await chrome.storage.local.get('vocabulary');
    const vocabulary = Array.isArray(stored) ? stored : [];
    const existing = vocabulary.find((item) => item?.lemma === candidate.lemma);
    if (!existing) {
      candidate.documentIds = [...new Set([...(candidate.documentIds || []), candidate.documentId].filter(Boolean))];
      candidate.contexts = [...new Set([...(candidate.contexts || []), candidate.context].filter(Boolean))].slice(-5);
      candidate.anchors = { ...(candidate.anchors || {}), ...(candidate.documentId && candidate.anchor ? { [candidate.documentId]:candidate.anchor } : {}) };
      candidate.occurrences = Math.max(1, Number(candidate.occurrences) || 1);
      vocabulary.push(candidate);
      await chrome.storage.local.set({ vocabulary });
      return { record:candidate, records:vocabulary, created:true };
    }
    const documentIds = [...new Set([...(existing.documentIds || [existing.documentId].filter(Boolean)), candidate.documentId].filter(Boolean))];
    const contexts = [...(existing.contexts || [existing.context].filter(Boolean)), candidate.context].filter(Boolean).slice(-5);
    const anchors = { ...(existing.anchors || {}) };
    if (candidate.documentId && candidate.anchor) anchors[candidate.documentId] = candidate.anchor;
    Object.assign(existing, {
      occurrences:Number(existing.occurrences || 1) + 1,
      lastSeenAt:Date.now(),
      updatedAt:Date.now(),
      documentIds,
      contexts,
      anchors,
      conversationId:candidate.conversationId || existing.conversationId,
      presentation:candidate.presentation || existing.presentation
    });
    await chrome.storage.local.set({ vocabulary });
    return { record:existing, records:vocabulary, created:false };
  }
  if (operation === 'patchVocabularyByLemma') {
    const lemma = String(mutation.lemma || '');
    const { vocabulary:stored = [] } = await chrome.storage.local.get('vocabulary');
    const vocabulary = Array.isArray(stored) ? stored : [];
    const record = vocabulary.find((item) => item?.lemma === lemma);
    if (!record) return { record:null, records:vocabulary };
    const changes = { ...objectValue(mutation.changes, 'Vocabulary changes') };
    delete changes.id;
    Object.assign(record, changes, { updatedAt:Date.now() });
    await chrome.storage.local.set({ vocabulary });
    return { record, records:vocabulary };
  }
  if (operation === 'putConversation' || operation === 'deleteConversation') {
    const key = String(mutation.key || '');
    if (!key.startsWith('conversation:')) throw new Error('Invalid conversation key.');
    const { aiConversations:stored = {} } = await chrome.storage.local.get('aiConversations');
    const aiConversations = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    if (operation === 'putConversation') aiConversations[key] = objectValue(mutation.value, 'Conversation');
    else delete aiConversations[key];
    await chrome.storage.local.set({ aiConversations });
    return { value:aiConversations[key] || null };
  }
  if (operation === 'upsertThread') {
    const payload = objectValue(mutation.payload, 'Thread payload');
    const documentId = String(payload.documentId || '');
    const conversationId = String(payload.conversationId || '');
    if (!documentId || !conversationId) throw new Error('Thread document and conversation ids are required.');
    const key = `thread:${documentId}`;
    const { sidePanelThreads:stored = {} } = await chrome.storage.local.get('sidePanelThreads');
    const sidePanelThreads = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const current = sidePanelThreads[key] || { documentId, documentTitle:payload.documentTitle, entries:[], scrollTop:0, updatedAt:0 };
    const entry = { conversationId, title:payload.title, body:payload.body, quote:payload.quote, context:payload.context, documentId, documentTitle:payload.documentTitle, presentation:payload.presentation || 'chat', updatedAt:Date.now() };
    const index = current.entries.findIndex((item) => item.conversationId === conversationId);
    if (index >= 0) current.entries[index] = { ...current.entries[index], ...entry };
    else current.entries.push(entry);
    current.documentTitle = payload.documentTitle || current.documentTitle;
    current.updatedAt = Date.now();
    current.entries = current.entries.slice(-50);
    sidePanelThreads[key] = current;
    await chrome.storage.local.set({ sidePanelThreads });
    return { thread:current };
  }
  if (operation === 'updateThreadScroll') {
    const documentId = String(mutation.documentId || '');
    const key = `thread:${documentId}`;
    const { sidePanelThreads:stored = {} } = await chrome.storage.local.get('sidePanelThreads');
    const sidePanelThreads = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    if (!sidePanelThreads[key]) return { thread:null };
    sidePanelThreads[key].scrollTop = Math.max(0, Number(mutation.scrollTop) || 0);
    await chrome.storage.local.set({ sidePanelThreads });
    return { thread:sidePanelThreads[key] };
  }
  if (operation === 'replaceCollections') {
    const values = objectValue(mutation.values, 'Replacement data');
    const allowed = ['annotations', 'vocabulary', 'aiConversations', 'sidePanelThreads'];
    const replacement = Object.fromEntries(allowed.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
    await chrome.storage.local.set(replacement);
    return { ok:true };
  }
  throw new Error('Unsupported storage mutation.');
}

function chatEndpoint(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/chat\/completions(?:\?|$)/.test(base) ? base : `${base}/chat/completions`;
}

function providerEndpoint(provider, endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (provider === 'gemini') return base;
  // Anthropic uses its own Messages endpoint rather than Chat Completions.
  // Settings normally contain the full `/v1/messages` URL, which must not be
  // rewritten; allow a host/base URL as well.
  if (provider === 'anthropic') {
    if (/\/v1\/messages(?:\?|$)/.test(base)) return base;
    return `${base}/v1/messages`;
  }
  // Ollama's native API is `/api/chat`, not the OpenAI-compatible
  // `/v1/chat/completions` route. Keep a complete native endpoint intact;
  // accept a host or `/api` base as a small convenience for custom installs.
  if (provider === 'ollama') {
    if (/\/api\/chat(?:\?|$)/.test(base)) return base;
    return /\/api(?:\?|$)/.test(base) ? `${base}/chat` : `${base}/api/chat`;
  }
  return chatEndpoint(base);
}

function aiResponseLanguage(settings) {
  const selected = settings.language === 'auto' || !settings.language ? chrome.i18n.getUILanguage() : settings.language;
  return /^zh(?:-|$)/i.test(selected) ? '简体中文' : 'English';
}

function textFromModelResponse(data) {
  const message = data.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => typeof part === 'string' ? part : (part.text || part.content || '')).join('').trim();
    if (text) return text;
  }
  const completion = data.choices?.[0]?.text;
  if (typeof completion === 'string' && completion.trim()) return completion;
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
  const output = Array.isArray(data.output) ? data.output.flatMap((item) => item.content || []).map((part) => part.text || part.value || '').join('').trim() : '';
  return output || '';
}

async function requestAI({ instruction, text, context = '', history = [], test = false }) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const provider = settings.provider || 'openai';
  const rawEndpoint = String(settings.endpoint || '').trim();
  const endpoint = providerEndpoint(provider, rawEndpoint);
  if (!endpoint || !settings.model || (!settings.apiKey && provider !== 'ollama')) return { ok: false, error: '请先在 Settings 填写 AI endpoint、模型，以及（Ollama 以外的）API key。' };
  const language = aiResponseLanguage(settings);
  // A full paragraph translation can legitimately be longer than an
  // explanation. Reserve enough output room for the no-omission contract.
  const maxOutputTokens = test ? 128 : /Translate every sentence in the selected text completely/i.test(String(instruction || '')) ? 4000 : 2200;
  const prompt = test ? 'Reply with exactly: LeafReader AI connected.' : `${instruction}\n\nText:\n${text}\n\nContext:\n${context}`;
  const priorMessages = Array.isArray(history) ? history.filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string').slice(-10) : [];
  const messages = test
    ? [{ role: 'user', content: 'Reply with exactly: LeafReader AI connected.' }]
    : [{ role: 'system', content: `You are a concise reading assistant. Reply in ${language}.` }, ...priorMessages, { role: 'user', content: `${instruction}\n\nText:\n${text}\n\nContext:\n${context}` }];
  try {
    let request;
    if (provider === 'anthropic') request = { endpoint, headers: { 'content-type':'application/json', 'x-api-key':settings.apiKey, 'anthropic-version':'2023-06-01' }, body: { model:settings.model, max_tokens:maxOutputTokens, system:`You are a concise reading assistant. Reply in ${language}.`, messages:test ? [{role:'user',content:prompt}] : messages.filter((message) => message.role !== 'system') }, read: (data) => data.content?.filter((part) => part.type === 'text').map((part) => part.text).join('') };
    else if (provider === 'gemini') request = { endpoint:`${endpoint}/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`, headers:{'content-type':'application/json'}, body:{ contents:(test ? [{ role:'user', content:prompt }] : messages.filter((message) => message.role !== 'system')).map((message) => ({ role:message.role === 'assistant' ? 'model' : 'user', parts:[{text:message.content}]})), generationConfig:{maxOutputTokens:maxOutputTokens,temperature:.2} }, read:(data) => data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') };
    else if (provider === 'ollama') request = { endpoint, headers:{'content-type':'application/json'}, body:{ model:settings.model, messages, stream:false, options:{temperature:.2,num_predict:maxOutputTokens} }, read:(data) => data.message?.content };
    else request = { endpoint, headers: { 'Content-Type':'application/json', ...(provider === 'azure' ? { 'api-key':settings.apiKey } : { 'Authorization':`Bearer ${settings.apiKey}` }) }, body:{ model:settings.model, messages, temperature:.2, max_tokens:maxOutputTokens }, read:textFromModelResponse };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), test ? 30000 : 60000);
    let response;
    try {
      response = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: `请求失败（HTTP ${response.status}）：${data.error?.message || data.message || '服务端未返回可读错误。'}` };
    const content = request.read(data);
    if (!content) {
      const topLevel = Object.keys(data).slice(0, 10).join(', ') || 'none';
      const choiceLevel = data.choices?.[0] ? Object.keys(data.choices[0]).slice(0, 10).join(', ') : 'none';
      const messageLevel = data.choices?.[0]?.message ? Object.keys(data.choices[0].message).slice(0, 10).join(', ') : 'none';
      const finishReason = data.choices?.[0]?.finish_reason || 'none';
      return { ok: false, error: `请求成功，但没有找到文本内容。响应字段：${topLevel}；首个 choice 字段：${choiceLevel}；message 字段：${messageLevel}；结束原因：${finishReason}。请确认供应商类型、endpoint 和模型名称。` };
    }
    const finishReason = data.choices?.[0]?.finish_reason || data.stop_reason || data.candidates?.[0]?.finishReason || data.done_reason || '';
    const truncated = /(?:length|max.?tokens?)/i.test(String(finishReason));
    const completed = `${String(content)}${truncated ? '\n\n> 回答达到模型的输出长度上限，可能未完整结束。请在下方继续追问“继续”。' : ''}`;
    return { ok: true, content: completed, endpoint: request.endpoint, truncated };
  } catch (error) {
    return { ok: false, error: `无法连接到 AI 服务：${error.message}` };
  }
}

async function openReader(tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return;
  try {
    const article = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_ARTICLE' });
    if (!article?.text) throw new Error('No readable content');
    await chrome.storage.session.set({ pendingArticle: article });
    await chrome.tabs.create({ url: READER_URL });
  } catch (error) {
    await chrome.storage.session.set({ pendingError: 'This page cannot be converted into reader mode.' });
    await chrome.tabs.create({ url: READER_URL });
  }
}

async function prepareLeafSidePanel(tabId) {
  if (!Number.isInteger(tabId)) return false;
  try {
    await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    return true;
  } catch (_) {
    return false;
  }
}

async function openLeafSidePanel(tab, payload, shouldOpen = false) {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId)) throw new Error('Chrome did not provide the current webpage tab for the Side Panel.');
  // Navigation and content-script startup normally prepare the tab before a
  // selection is made. Start a final preparation request as a safeguard, but
  // call `open()` immediately so it remains within the selection click's
  // trusted user gesture.
  const preparing = prepareLeafSidePanel(tabId);
  // This is Chrome's supported content-script gesture hand-off: target the
  // sender's tab directly. Opening by window lost the gesture in some Chrome
  // builds even though it is otherwise a valid Side Panel API context.
  const opening = shouldOpen ? chrome.sidePanel.open({ tabId }).then(() => true).catch(() => false) : null;
  await chrome.storage.session.set({ leafReaderSidePanel: { tabId, payload: { ...payload, tabId }, updatedAt: Date.now() } });
  await preparing;
  if (opening && !(await opening)) throw new Error('Chrome could not open the Side Panel for this tab. Please try the AI action again after the page finishes loading.');
}

async function clearLeafSidePanel(tabId, discardAnyPanel = false) {
  if (!Number.isInteger(tabId)) return;
  const { leafReaderSidePanel } = await chrome.storage.session.get('leafReaderSidePanel');
  if (discardAnyPanel || leafReaderSidePanel?.tabId === tabId) await chrome.storage.session.remove('leafReaderSidePanel');
}

chrome.action.onClicked.addListener(openReader);
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-reader') openReader((await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Clear stale content on navigation. We deliberately keep the native panel
  // enabled: repeatedly disabling/enabling it races Chrome's first open.
  if (changeInfo.status === 'loading' || changeInfo.url) void prepareLeafSidePanel(tabId);
  if (changeInfo.status === 'loading' || changeInfo.url) void clearLeafSidePanel(tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void prepareLeafSidePanel(tabId);
  chrome.storage.session.get('leafReaderSidePanel').then(({ leafReaderSidePanel }) => {
    if (leafReaderSidePanel?.tabId !== tabId) void clearLeafSidePanel(tabId, true);
  });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'STORAGE_MUTATION') {
    enqueueStorageMutation(() => mutateStorage(message.mutation))
      .then((result) => respond({ ok:true, ...result }))
      .catch((error) => respond({ ok:false, error:error.message }));
    return true;
  }
  if (message.type === 'AI_REQUEST' || message.type === 'AI_CHAT' || message.type === 'AI_TEST') {
    requestAI({ ...message, test: message.type === 'AI_TEST' }).then(respond);
    return true;
  }
  if (message.type === 'OPEN_LEAF_SIDEPANEL') {
    openLeafSidePanel(sender.tab, message.payload, Boolean(message.open)).then(() => respond({ ok: true })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'PREPARE_SIDE_PANEL') {
    prepareLeafSidePanel(sender.tab?.id)
      .then((ok) => respond(ok ? { ok: true } : { ok: false, error: 'Chrome could not enable the Side Panel for this tab.' }));
    return true;
  }
  if (message.type === 'PAGE_CHANGED') {
    clearLeafSidePanel(sender.tab?.id).then(() => respond({ ok: true }));
    return true;
  }
  if (message.type === 'ANNOTATION_SAVED') {
    const tabId = Number(message.tabId);
    if (Number.isInteger(tabId)) chrome.tabs.sendMessage(tabId, { type: 'ANNOTATION_SAVED', record: message.record }).catch(() => {});
    respond({ ok: true });
    return;
  }
  if (message.type === 'OPEN_DOCUMENT_SOURCE') {
    const url = String(message.documentId || '').replace(/^web:/, '');
    if (/^https?:/i.test(url)) chrome.tabs.create({ url });
    respond({ ok: true });
    return;
  }
  if (message.type === 'OPEN_READER_FROM_SIDEPANEL') {
    chrome.storage.session.get('leafReaderSidePanel').then(async ({ leafReaderSidePanel }) => {
      const tabId = leafReaderSidePanel?.tabId;
      if (!Number.isInteger(tabId)) return respond({ ok: false, error: 'There is no active webpage associated with this Side Panel.' });
      try {
        await openReader(await chrome.tabs.get(tabId));
        respond({ ok: true });
      } catch (error) {
        respond({ ok: false, error: error.message });
      }
    });
    return true;
  }
  if (message.type === 'OPEN_READER') {
    openReader(sender.tab);
    respond({ ok: true });
  }
  if (message.type === 'OPEN_ACTIVE_PAGE') {
    chrome.tabs.query({ currentWindow: true }).then((tabs) => {
      const page = tabs.filter((tab) => /^https?:/.test(tab.url || '')).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      openReader(page);
    });
    respond({ ok: true });
  }
});
