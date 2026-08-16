const panel = document.querySelector("#panel");
const { esc, markdown } = window.LeafReaderMarkdown;
const { isThreadPayload } = window.LeafReaderPanelPayload;
const {
  appendFollowUp,
  clearConversation,
  conversationKey,
  ensureInitialConversation,
  loadConversation,
  loadConversationMap,
  pending: isPendingResponse,
  readThread,
  saveThreadScroll,
  upsertThread,
} = window.LeafReaderPanelStore;

const loadingMarkup = (label = "Thinking…") =>
  `<div class="loading-state"><i class="spinner" aria-hidden="true"></i><span>${esc(label)}</span></div>`;
const messageHistory = (messages) =>
  `<div class="chat-history">${messages.map((message) => `<section class="chat-message ${message.role}"><div class="label">${message.role === "user" ? "YOU" : "LEAFREADER"}</div><div class="markdown">${message.role === "user" ? `<p>${esc(message.content)}</p>` : markdown(message.content)}</div></section>`).join("")}</div>`;
function resultContent(payload, messages) {
  if (!messages.length)
    return isPendingResponse(payload.body)
      ? loadingMarkup(payload.body)
      : `<div class="markdown">${markdown(payload.body)}</div>`;
  // A selected word is already shown in the Selected text card. Repeating it
  // as a "YOU" message makes dictionary results needlessly tall. Keep the
  // initial definition compact, then show genuine follow-up turns normally.
  if (messages[0]?.role === "user" && messages[1]?.role === "assistant") {
    const initialClass =
      payload.presentation === "dictionary"
        ? "dictionary-result"
        : "initial-answer";
    return `<div class="${initialClass} markdown">${markdown(messages[1].content)}</div>${messages.length > 2 ? messageHistory(messages.slice(2)) : ""}`;
  }
  return messageHistory(messages);
}
async function askFollowUp(payload, question, history) {
  const result = await chrome.runtime.sendMessage({
    type: "AI_CHAT",
    instruction: question,
    text: payload.quote || "",
    context: payload.context || "",
    history,
  });
  if (!result?.ok) {
    throw new Error(result?.error || "AI provider returned no response.");
  }
  return appendFollowUp(payload, question, result.content);
}
function downloadConversation(payload, messages) {
  const content = [
    `# ${payload.documentTitle || "LeafReader conversation"}`,
    "",
    `> ${payload.quote || ""}`,
    "",
    ...messages.map(
      (message) =>
        `## ${message.role === "user" ? "You" : "LeafReader"}\n\n${message.content}`,
    ),
  ].join("\n\n");
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "leafreader-conversation.md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function followUpMarkup() {
  return `<div class="composer"><form class="follow-up" id="followUp"><input id="followUpText" placeholder="Ask a follow-up about this text…"><button>Send</button></form><div class="conversation-tools"><button id="exportConversation">Export</button><button id="clearConversation">Clear</button></div></div>`;
}
function bindFollowUp(payload, messages) {
  const form = document.querySelector("#followUp");
  if (form)
    form.onsubmit = async (event) => {
      event.preventDefault();
      const input = document.querySelector("#followUpText");
      const submit = form.querySelector("button");
      const question = input.value.trim();
      if (!question) return;
      input.value = "";
      input.disabled = true;
      submit.disabled = true;
      const pending = document.createElement("div");
      pending.className = "chat-history pending-turn";
      pending.innerHTML = `<section class="chat-message user"><div class="label">YOU</div><div class="markdown"><p>${esc(question)}</p></div></section><section class="chat-message assistant"><div class="label">LEAFREADER</div>${loadingMarkup("Thinking…")}</section>`;
      const content = panel.querySelector(".panel-content");
      content?.append(pending);
      scrollThreadToEnd(panel);
      try {
        const updated = await askFollowUp(payload, question, messages);
        await render({
          ...payload,
          body: updated.at(-1).content,
          conversationMessages: updated,
        });
      } catch (error) {
        const assistant = pending.querySelector(".chat-message.assistant");
        if (assistant)
          assistant.innerHTML = `<div class="label">LEAFREADER</div><div class="markdown"><p>${esc(error.message || "The AI request failed.")}</p></div>`;
        input.disabled = false;
        submit.disabled = false;
        input.focus();
      }
    };
  document
    .querySelector("#exportConversation")
    ?.addEventListener("click", () => downloadConversation(payload, messages));
  document
    .querySelector("#clearConversation")
    ?.addEventListener("click", async () => {
      await clearConversation(payload);
      await render({
        ...payload,
        body: "Conversation cleared. Ask a follow-up to start again.",
        conversationCleared: true,
      });
    });
}
const saveScrollTimers = new Map();
function persistThreadScroll(documentId, scrollTop) {
  clearTimeout(saveScrollTimers.get(documentId));
  saveScrollTimers.set(
    documentId,
    setTimeout(() => {
      void saveThreadScroll(documentId, scrollTop);
    }, 180),
  );
}
function scrollThreadToEnd(content) {
  if (!content) return;
  const apply = () => {
    content.scrollTop = content.scrollHeight;
  };
  // The native Side Panel assigns its final height after its document renders.
  // Run on frames and once after layout settles, not only before overflow exists.
  requestAnimationFrame(apply);
  requestAnimationFrame(() => requestAnimationFrame(apply));
  setTimeout(apply, 180);
}
function scrollThreadResponseToTop(content, conversationId) {
  if (!content || !conversationId) return scrollThreadToEnd(content);
  const response = [...content.querySelectorAll("[data-thread-response]")].find(
    (element) => element.dataset.threadResponse === conversationId,
  );
  if (!response) return scrollThreadToEnd(content);
  const apply = () => {
    if (!content.isConnected || !response.isConnected) return;
    const distance =
      response.getBoundingClientRect().top -
      content.getBoundingClientRect().top -
      19;
    content.scrollTop = Math.max(0, content.scrollTop + distance);
  };
  requestAnimationFrame(apply);
  requestAnimationFrame(() => requestAnimationFrame(apply));
  setTimeout(apply, 180);
}
async function renderThread(payload, writePayload = true) {
  const thread = writePayload
    ? await upsertThread(payload)
    : await readThread(payload.documentId);
  if (!thread?.entries?.length) return false;
  if (writePayload) await ensureInitialConversation(payload);
  const entries = thread.entries;
  const active =
    entries.find((entry) => entry.conversationId === payload.conversationId) ||
    entries.at(-1);
  const conversations = await loadConversationMap(entries);
  const rendered = entries.map((entry) => {
    const messages = conversations[entry.conversationId] || [];
    return `<article class="thread-entry" data-thread-entry="${esc(entry.conversationId)}"><div class="entry-title">${esc(entry.title || "LeafReader")}</div><div class="label">SELECTED TEXT</div><blockquote>${esc(entry.quote)}</blockquote><div class="entry-response" data-thread-response="${esc(entry.conversationId)}">${resultContent(entry, messages)}</div></article>`;
  });
  const activeMessages = conversations[active.conversationId] || [];
  panel.innerHTML = `<div class="panel-content"><h1>${esc(thread.documentTitle || payload.documentTitle || "LeafReader")}</h1><div class="thread-list">${rendered.join("")}</div></div>${followUpMarkup()}`;
  bindFollowUp(active, activeMessages);
  panel.addEventListener(
    "scroll",
    () => persistThreadScroll(thread.documentId, panel.scrollTop),
    { passive: true },
  );
  if (writePayload || payload.restoreThread)
    scrollThreadResponseToTop(panel, active.conversationId);
  else
    requestAnimationFrame(() => {
      panel.scrollTop = thread.scrollTop || 0;
    });
  return true;
}
async function render(payload) {
  if (!payload) return;
  if (payload.mode === "note") {
    panel.innerHTML = `<div class="panel-content"><h1>${esc(payload.title || "Add a note")}</h1><div class="label">SELECTED TEXT</div><blockquote>${esc(payload.quote)}</blockquote><textarea id="note" placeholder="What do you want to remember?"></textarea><button class="primary" id="save">Save note</button></div>`;
    document.querySelector("#save").onclick = async () => {
      try {
        const note = document.querySelector("#note").value.trim();
        const record = {
          id: `note:${crypto.randomUUID()}`,
          documentId: payload.documentId,
          documentTitle: payload.documentTitle,
          quote: payload.quote,
          context: payload.context,
          anchor: payload.anchor || null,
          note,
          kind: "note",
          favorite: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const saved = await chrome.runtime.sendMessage({
          type: "UPSERT_RECORD",
          collection: "annotations",
          record,
        });
        if (!saved?.ok) {
          throw new Error(saved?.error || "Could not save note.");
        }
        await chrome.runtime.sendMessage({
          type: "ANNOTATION_SAVED",
          tabId: payload.tabId,
          record: saved.record,
        });
        panel.innerHTML = `<div class="panel-content"><h1>Note saved</h1><div class="label">SELECTED TEXT</div><blockquote>${esc(payload.quote)}</blockquote><p class="message">${esc(note || "Saved without a written note.")}</p></div>`;
      } catch (error) {
        panel.innerHTML = `<div class="panel-content"><strong>Save failed:</strong> ${esc(error.message)}</div>`;
      }
    };
    return;
  }
  // Clicking a marker on the original webpage restores its existing
  // URL-scoped thread. It must not overwrite that entry with a placeholder.
  if (payload.restoreThread && (await renderThread(payload, false))) return;
  if (
    !payload.viewOnly &&
    isThreadPayload(payload) &&
    (await renderThread(payload, true))
  ) {
    return;
  }
  // The first click opens the native frame with a neutral Loading payload.
  // Do not wipe an existing page trail during that short hand-off.
  if (
    !payload.viewOnly &&
    payload.documentId &&
    (await renderThread(payload, false))
  ) {
    return;
  }
  const messages = payload.viewOnly
    ? await loadConversation(payload)
    : await ensureInitialConversation(payload);
  panel.innerHTML = `<div class="panel-content"><h1>${esc(payload.title || "LeafReader")}</h1>${payload.quote ? `<div class="label">SELECTED TEXT</div><blockquote>${esc(payload.quote)}</blockquote>` : ""}${resultContent(payload, messages)}</div>${conversationKey(payload) ? followUpMarkup() : ""}`;
  if (conversationKey(payload)) bindFollowUp(payload, messages);
}
async function renderHistory() {
  const { aiConversations: conversations } =
    await window.LeafReaderPanelStore.exportData();
  const entries = Object.entries(conversations).sort(
    ([, left], [, right]) => (right.updatedAt || 0) - (left.updatedAt || 0),
  );
  panel.innerHTML = entries.length
    ? `<div class="panel-content"><h1>AI conversations</h1><div class="conversation-list">${entries.map(([key, conversation]) => `<button data-conversation="${esc(key)}"><strong>${esc(conversation.documentTitle || "Webpage")}</strong><span>${esc(conversation.quote || conversation.messages?.at(-1)?.content || "").slice(0, 105)}</span><small>${new Date(conversation.updatedAt || 0).toLocaleString()}</small></button>`).join("")}</div></div>`
    : `<div class="panel-content"><div class="empty"><b>☘</b><h1>No conversations yet</h1><p>Use Translate, Dictionary, or AI on a webpage, then continue the conversation here.</p></div></div>`;
  panel.querySelectorAll("[data-conversation]").forEach(
    (button) =>
      (button.onclick = () => {
        const key = button.dataset.conversation;
        const conversation = conversations[key];
        if (!conversation) return;
        const latest =
          conversation.messages
            ?.filter((message) => message.role === "assistant")
            .at(-1)?.content || "";
        void render({
          title: "LeafReader AI",
          body: latest,
          documentId: conversation.documentId,
          documentTitle: conversation.documentTitle,
          quote: conversation.quote,
          context: conversation.context,
          presentation: conversation.presentation,
          conversationId: key.replace(/^conversation:/, ""),
          viewOnly: true,
        });
      }),
  );
}
function renderEmpty() {
  panel.innerHTML = `<div class="panel-content"><div class="empty"><b>☘</b><h1>Ready to read</h1><p>Select text on the webpage to translate, look up, annotate, or ask AI.</p></div></div>`;
}
async function renderActivePageThread() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/i.test(tab?.url || "")) {
    renderEmpty();
    return;
  }
  const documentId = `web:${tab.url}`;
  const thread = await readThread(documentId);
  if (!thread?.entries?.length) {
    renderEmpty();
    return;
  }
  const latest = thread.entries.at(-1);
  await renderThread(
    { ...latest, documentId, documentTitle: tab.title || thread.documentTitle },
    false,
  );
}
async function load() {
  const { leafReaderSidePanel } = await chrome.storage.session.get(
    "leafReaderSidePanel",
  );
  if (leafReaderSidePanel?.payload) await render(leafReaderSidePanel.payload);
  else await renderActivePageThread();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.leafReaderSidePanel) return;
  if (changes.leafReaderSidePanel.newValue?.payload)
    void render(changes.leafReaderSidePanel.newValue.payload);
  else void renderActivePageThread();
});
const openReaderButton = document.querySelector("#openReader");
const headerActions = document.createElement("div");
headerActions.className = "header-actions";
const historyButton = document.createElement("button");
historyButton.id = "viewHistory";
historyButton.title = "AI conversation history";
historyButton.textContent = "☷";
openReaderButton.replaceWith(headerActions);
headerActions.append(historyButton, openReaderButton);
historyButton.onclick = () => void renderHistory();
openReaderButton.onclick = () =>
  chrome.runtime.sendMessage({ type: "OPEN_READER_FROM_SIDEPANEL" });
load();
