const panel = document.querySelector('#panel');
const panelTitle = document.querySelector('#panelTitle');
const esc = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const setPanelTitle = (value) => { panelTitle.textContent = !value || value === 'LeafReader' ? 'Reading companion' : value; panelTitle.title = panelTitle.textContent; };
let renderGeneration = 0;
const currentRender = (generation) => generation === renderGeneration;
async function mutateStorage(mutation) {
  const result = await chrome.runtime.sendMessage({ type:'STORAGE_MUTATION', mutation });
  if (!result?.ok) throw new Error(result?.error || 'LeafReader could not save local data.');
  return result;
}
function inlineMarkdown(value) {
  return esc(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');
}
function markdown(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const output = []; let paragraph = []; let list = null;
  const tableCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const isTableSeparator = (line) => line.includes('|') && tableCells(line).length > 1 && tableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`); paragraph = []; } };
  const flushList = () => { if (list) { output.push(`<${list.type}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${list.type}>`); list = null; } };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const quote = line.match(/^>\s?(.+)$/);
    if (line.includes('|') && isTableSeparator(lines[index + 1] || '')) {
      flushParagraph(); flushList(); const headers = tableCells(line); const rows = []; index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { rows.push(tableCells(lines[index])); index += 1; }
      index -= 1;
      output.push(`<div class="table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cell) => `<td>${inlineMarkdown(row[cell] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    }
    else if (heading) { flushParagraph(); flushList(); const level = heading[1].length; output.push(`<h${level + 1}>${inlineMarkdown(heading[2])}</h${level + 1}>`); }
    else if (bullet || ordered) { flushParagraph(); const type = ordered ? 'ol' : 'ul'; if (!list || list.type !== type) { flushList(); list = { type, items: [] }; } list.items.push((bullet || ordered)[1]); }
    else if (quote) { flushParagraph(); flushList(); output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); }
    else if (!line.trim()) { flushParagraph(); flushList(); }
    else { flushList(); paragraph.push(line); }
  }
  flushParagraph(); flushList(); return output.join('') || '<p></p>';
}
const conversationKey = (payload) => payload?.conversationId ? `conversation:${payload.conversationId}` : '';
const isPendingResponse = (value) => /^(?:thinking|loading|正在|处理中|请求中|请稍候)/i.test(String(value || '').trim());
const loadingMarkup = (label = 'Thinking…') => `<div class="loading-state"><i class="spinner" aria-hidden="true"></i><span>${esc(label)}</span></div>`;
const messageHistory = (messages) => `<div class="chat-history">${messages.map((message) => `<section class="chat-message ${message.role}"><div class="label">${message.role === 'user' ? 'YOU' : 'LEAFREADER'}</div><div class="markdown">${message.role === 'user' ? `<p>${esc(message.content)}</p>` : markdown(message.content)}</div></section>`).join('')}</div>`;
function resultContent(payload, messages) {
  if (!messages.length) return isPendingResponse(payload.body)
    ? loadingMarkup(payload.body)
    : `<div class="markdown">${markdown(payload.body)}</div>`;
  // A selected word is already shown in the Selected text card. Repeating it
  // as a "YOU" message makes dictionary results needlessly tall. Keep the
  // initial definition compact, then show genuine follow-up turns normally.
  if (messages[0]?.role === 'user' && messages[1]?.role === 'assistant') {
    const initialClass = payload.presentation === 'dictionary' ? 'dictionary-result' : 'initial-answer';
    return `<div class="${initialClass} markdown">${markdown(messages[1].content)}</div>${messages.length > 2 ? messageHistory(messages.slice(2)) : ''}`;
  }
  return messageHistory(messages);
}
async function loadConversation(payload) {
  const key = conversationKey(payload); if (!key) return [];
  if (payload.conversationCleared) return [];
  const { aiConversations = {} } = await chrome.storage.local.get('aiConversations');
  const existing = aiConversations[key]?.messages || [];
  // A progress label is transient UI, never a conversation response. In
  // particular, dictionary lookup starts in Chinese ("正在按上下文解释…");
  // persisting it made the later model answer look permanently stuck.
  const stalePending = existing.length === 2 && existing[0]?.role === 'user' && existing[1]?.role === 'assistant' && isPendingResponse(existing[1]?.content);
  if ((existing.length && !stalePending) || !payload.body || isPendingResponse(payload.body)) return existing;
  const messages = stalePending
    ? [{ role:'user', content:existing[0].content }, { role:'assistant', content:payload.body }]
    : [{ role:'user', content:payload.quote || 'Selected webpage text' }, { role:'assistant', content:payload.body }];
  const value = { documentId:payload.documentId, documentTitle:payload.documentTitle, quote:payload.quote, context:payload.context, presentation:payload.presentation || 'chat', updatedAt:Date.now(), messages };
  await mutateStorage({ operation:'putConversation', key, value }); return messages;
}
async function askFollowUp(payload, question, history) {
  const key = conversationKey(payload); const next = [...history, { role:'user', content:question }];
  const result = await chrome.runtime.sendMessage({ type:'AI_CHAT', instruction:question, text:payload.quote || '', context:payload.context || '', history:next.slice(0, -1) });
  if (!result?.ok) throw new Error(result?.error || 'AI provider returned no response.');
  const messages = [...next, { role:'assistant', content:result.content }];
  const value = { documentId:payload.documentId, documentTitle:payload.documentTitle, quote:payload.quote, context:payload.context, presentation:payload.presentation || 'chat', updatedAt:Date.now(), messages };
  await mutateStorage({ operation:'putConversation', key, value }); return messages;
}
function downloadConversation(payload, messages) {
  const content = [`# ${payload.documentTitle || 'LeafReader conversation'}`, '', `> ${payload.quote || ''}`, '', ...messages.map((message) => `## ${message.role === 'user' ? 'You' : 'LeafReader'}\n\n${message.content}`)].join('\n\n');
  const url = URL.createObjectURL(new Blob([content], { type:'text/markdown;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'leafreader-conversation.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const threadKey = (documentId) => documentId ? `thread:${documentId}` : '';
const isThreadPayload = (payload) => payload?.mode === 'result' && Boolean(payload?.documentId && payload?.conversationId);
async function readThread(documentId) {
  const key = threadKey(documentId); if (!key) return null;
  const { sidePanelThreads = {} } = await chrome.storage.local.get('sidePanelThreads');
  return sidePanelThreads[key] || null;
}
async function upsertThread(payload) {
  if (!threadKey(payload.documentId)) return null;
  return (await mutateStorage({ operation:'upsertThread', payload })).thread;
}
function followUpMarkup() {
  return `<div class="composer"><form class="follow-up" id="followUp"><input id="followUpText" placeholder="Ask a follow-up about this text…"><button>Send</button></form><div class="conversation-tools"><button id="exportConversation">Export</button><button id="clearConversation">Clear</button></div></div>`;
}
function bindFollowUp(payload, messages, generation) {
  const form = document.querySelector('#followUp');
  if (form) form.onsubmit = async (event) => {
    event.preventDefault();
    const input = document.querySelector('#followUpText'); const submit = form.querySelector('button'); const question = input.value.trim();
    if (!question) return;
    input.value = ''; input.disabled = true; submit.disabled = true;
    const pending = document.createElement('div'); pending.className = 'chat-history pending-turn';
    pending.innerHTML = `<section class="chat-message user"><div class="label">YOU</div><div class="markdown"><p>${esc(question)}</p></div></section><section class="chat-message assistant"><div class="label">LEAFREADER</div>${loadingMarkup('Thinking…')}</section>`;
    const content = panel.querySelector('.panel-content');
    content?.append(pending); scrollThreadToEnd(content);
    try {
      const updated = await askFollowUp(payload, question, messages);
      if (!currentRender(generation)) return;
      await render({ ...payload, body:updated.at(-1).content, conversationMessages:updated });
    } catch (error) {
      if (!currentRender(generation)) return;
      const assistant = pending.querySelector('.chat-message.assistant');
      if (assistant) assistant.innerHTML = `<div class="label">LEAFREADER</div><div class="markdown"><p>${esc(error.message || 'The AI request failed.')}</p></div>`;
      input.disabled = false; submit.disabled = false; input.focus();
    }
  };
  document.querySelector('#exportConversation')?.addEventListener('click', () => downloadConversation(payload, messages));
  document.querySelector('#clearConversation')?.addEventListener('click', async () => {
    const key = conversationKey(payload); await mutateStorage({ operation:'deleteConversation', key });
    if (!currentRender(generation)) return;
    await render({ ...payload, body:'Conversation cleared. Ask a follow-up to start again.', conversationCleared:true });
  });
}
let saveScrollTimer = 0;
function persistThreadScroll(documentId, scrollTop) {
  clearTimeout(saveScrollTimer);
  saveScrollTimer = setTimeout(async () => {
    if (!threadKey(documentId)) return;
    await mutateStorage({ operation:'updateThreadScroll', documentId, scrollTop }).catch(() => {});
  }, 180);
}
function scrollThreadToEnd(content) {
  if (!content) return;
  // A second frame accounts for markdown/table layout settling after the
  // panel has been inserted into Chrome's native side-panel frame.
  requestAnimationFrame(() => {
    content.scrollTop = content.scrollHeight;
    requestAnimationFrame(() => { if (content.isConnected) content.scrollTop = content.scrollHeight; });
  });
}
function scrollThreadResponseToTop(content, conversationId) {
  if (!content || !conversationId) return scrollThreadToEnd(content);
  const response = [...content.querySelectorAll('[data-thread-response]')].find((element) => element.dataset.threadResponse === conversationId);
  if (!response) return scrollThreadToEnd(content);
  requestAnimationFrame(() => {
    content.scrollTop = Math.max(0, response.offsetTop - 19);
    requestAnimationFrame(() => { if (content.isConnected) content.scrollTop = Math.max(0, response.offsetTop - 19); });
  });
}
async function renderThread(payload, writePayload = true, generation = renderGeneration) {
  const thread = writePayload ? await upsertThread(payload) : await readThread(payload.documentId);
  if (!currentRender(generation) || !thread?.entries?.length) return false;
  const entries = thread.entries;
  const active = entries.find((entry) => entry.conversationId === payload.conversationId) || entries.at(-1);
  const rendered = await Promise.all(entries.map(async (entry) => {
    const messages = await loadConversation(entry);
    return `<article class="thread-entry" data-thread-entry="${esc(entry.conversationId)}"><div class="entry-title">${esc(entry.title || 'LeafReader')}</div><div class="label">SELECTED TEXT</div><blockquote>${esc(entry.quote)}</blockquote><div class="entry-response" data-thread-response="${esc(entry.conversationId)}">${resultContent(entry, messages)}</div></article>`;
  }));
  const activeMessages = await loadConversation(active);
  if (!currentRender(generation)) return false;
  setPanelTitle(thread.documentTitle || payload.documentTitle || 'LeafReader');
  panel.innerHTML = `<div class="panel-content"><div class="thread-list">${rendered.join('')}</div></div>${followUpMarkup()}`;
  bindFollowUp(active, activeMessages, generation);
  const content = panel.querySelector('.panel-content');
  content?.addEventListener('scroll', () => persistThreadScroll(thread.documentId, content.scrollTop), { passive:true });
  if (writePayload || payload.restoreThread) scrollThreadResponseToTop(content, active.conversationId);
  else requestAnimationFrame(() => { if (content) content.scrollTop = thread.scrollTop || 0; });
  return true;
}
async function renderPayload(payload, generation) {
  if (!payload) return;
  if (payload.mode === 'note') {
    if (!currentRender(generation)) return;
    setPanelTitle(payload.title || 'Add a note');
    panel.innerHTML = `<div class="panel-content"><div class="label">SELECTED TEXT</div><blockquote>${esc(payload.quote)}</blockquote><textarea id="note" placeholder="What do you want to remember?"></textarea><button class="primary" id="save">Save note</button></div>`;
    document.querySelector('#save').onclick = async () => {
      const note = document.querySelector('#note').value.trim();
      const record = { id:`note:${crypto.randomUUID()}`, documentId:payload.documentId, documentTitle:payload.documentTitle, quote:payload.quote, context:payload.context, anchor:payload.anchor || null, note, kind:'note', favorite:false, createdAt:Date.now(), updatedAt:Date.now() };
      await mutateStorage({ operation:'addRecord', key:'annotations', record });
      await chrome.runtime.sendMessage({ type:'ANNOTATION_SAVED', tabId:payload.tabId, record });
      if (!currentRender(generation)) return;
      setPanelTitle('Note saved');
      panel.innerHTML = `<div class="panel-content"><div class="label">SELECTED TEXT</div><blockquote>${esc(payload.quote)}</blockquote><p class="message">${esc(note || 'Saved without a written note.')}</p></div>`;
    };
    return;
  }
  // Clicking a marker on the original webpage restores its existing
  // URL-scoped thread. It must not overwrite that entry with a placeholder.
  if (payload.restoreThread && await renderThread(payload, false, generation)) return;
  if (!currentRender(generation)) return;
  if (isThreadPayload(payload) && await renderThread(payload, true, generation)) return;
  if (!currentRender(generation)) return;
  // The first click opens the native frame with a neutral Loading payload.
  // Do not wipe an existing page trail during that short hand-off.
  if (payload.documentId && await renderThread(payload, false, generation)) return;
  if (!currentRender(generation)) return;
  const messages = await loadConversation(payload);
  if (!currentRender(generation)) return;
  setPanelTitle(payload.title || 'LeafReader');
  panel.innerHTML = `<div class="panel-content">${payload.quote ? `<div class="label">SELECTED TEXT</div><blockquote>${esc(payload.quote)}</blockquote>` : ''}${resultContent(payload, messages)}</div>${conversationKey(payload) ? followUpMarkup() : ''}`;
  if (conversationKey(payload)) bindFollowUp(payload, messages, generation);
}
async function render(payload) {
  const generation = ++renderGeneration;
  return renderPayload(payload, generation);
}
async function renderHistory() {
  const generation = ++renderGeneration;
  const { aiConversations = {} } = await chrome.storage.local.get('aiConversations');
  if (!currentRender(generation)) return;
  const entries = Object.entries(aiConversations).sort(([, left], [, right]) => (right.updatedAt || 0) - (left.updatedAt || 0));
  setPanelTitle('AI conversations');
  panel.innerHTML = entries.length ? `<div class="panel-content"><div class="conversation-list">${entries.map(([key, conversation]) => `<button data-conversation="${esc(key)}"><strong>${esc(conversation.documentTitle || 'Webpage')}</strong><span>${esc(conversation.quote || conversation.messages?.at(-1)?.content || '').slice(0, 105)}</span><small>${new Date(conversation.updatedAt || 0).toLocaleString()}</small></button>`).join('')}</div></div>` : `<div class="panel-content"><div class="empty"><b>☘</b><p>No conversations yet. Use Translate, Dictionary, or AI on a webpage, then continue the conversation here.</p></div></div>`;
  panel.querySelectorAll('[data-conversation]').forEach((button) => button.onclick = () => { const key = button.dataset.conversation; const conversation = aiConversations[key]; if (!conversation) return; const latest = conversation.messages?.filter((message) => message.role === 'assistant').at(-1)?.content || ''; void render({ title:'LeafReader AI', body:latest, documentId:conversation.documentId, documentTitle:conversation.documentTitle, quote:conversation.quote, context:conversation.context, presentation:conversation.presentation, conversationId:key.replace(/^conversation:/, '') }); });
}
function renderEmpty(generation = renderGeneration) { if (currentRender(generation)) { setPanelTitle('Ready to read'); panel.innerHTML = `<div class="panel-content"><div class="empty"><b>☘</b><p>Select text on the webpage to translate, look up, annotate, or ask AI.</p></div></div>`; } }
async function renderActivePageThread() {
  const generation = ++renderGeneration;
  const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
  if (!currentRender(generation)) return;
  if (!/^https?:/i.test(tab?.url || '')) { renderEmpty(generation); return; }
  const documentId = `web:${tab.url}`;
  const thread = await readThread(documentId);
  if (!currentRender(generation)) return;
  if (!thread?.entries?.length) { renderEmpty(generation); return; }
  const latest = thread.entries.at(-1);
  await renderThread({ ...latest, documentId, documentTitle:tab.title || thread.documentTitle }, false, generation);
}
async function load() { const { leafReaderSidePanel } = await chrome.storage.session.get('leafReaderSidePanel'); if (leafReaderSidePanel?.payload) await render(leafReaderSidePanel.payload); else await renderActivePageThread(); }
chrome.storage.session.onChanged.addListener((changes) => { if (!changes.leafReaderSidePanel) return; if (changes.leafReaderSidePanel.newValue?.payload) void render(changes.leafReaderSidePanel.newValue.payload); else void renderActivePageThread(); });
const openReaderButton = document.querySelector('#openReader'); const headerActions = document.createElement('div'); headerActions.className = 'header-actions'; const historyButton = document.createElement('button'); historyButton.id = 'viewHistory'; historyButton.title = 'AI conversation history'; historyButton.textContent = '☷'; openReaderButton.replaceWith(headerActions); headerActions.append(historyButton, openReaderButton);
historyButton.onclick = () => void renderHistory();
openReaderButton.onclick = () => chrome.runtime.sendMessage({ type:'OPEN_READER_FROM_SIDEPANEL' });
load();
