/* URL-scoped Side Panel data. All read-modify-write storage changes are
 * serialized so a scroll update cannot overwrite a newly completed answer. */
(() => {
  let writeQueue = Promise.resolve();
  const conversationsKey = "aiConversations";
  const threadsKey = "sidePanelThreads";

  const conversationKey = (payload) =>
    payload?.conversationId ? `conversation:${payload.conversationId}` : "";
  const threadKey = (documentId) => (documentId ? `thread:${documentId}` : "");
  const pending = (value) =>
    /^(?:thinking|loading|正在|处理中|请求中|请稍候)/i.test(
      String(value || "").trim(),
    );

  function mutate(storageKey, update) {
    const task = writeQueue.then(async () => {
      const stored = await chrome.storage.local.get(storageKey);
      const value = structuredClone(stored[storageKey] || {});
      const result = await update(value);
      await chrome.storage.local.set({ [storageKey]: value });
      return result;
    });
    writeQueue = task.catch(() => {});
    return task;
  }

  function messageRecord(payload, messages) {
    return {
      documentId: payload.documentId,
      documentTitle: payload.documentTitle,
      quote: payload.quote,
      context: payload.context,
      presentation: payload.presentation || "chat",
      updatedAt: Date.now(),
      messages,
    };
  }

  async function loadConversation(payload) {
    const key = conversationKey(payload);
    if (!key || payload.conversationCleared) return [];
    const { [conversationsKey]: conversations = {} } =
      await chrome.storage.local.get(conversationsKey);
    return conversations[key]?.messages || [];
  }

  function ensureInitialConversation(payload) {
    const key = conversationKey(payload);
    if (!key || !payload.body || pending(payload.body))
      return loadConversation(payload);
    return mutate(conversationsKey, (conversations) => {
      const existing = conversations[key]?.messages || [];
      const stalePending =
        existing.length === 2 &&
        existing[0]?.role === "user" &&
        existing[1]?.role === "assistant" &&
        pending(existing[1]?.content);
      if (existing.length && !stalePending) return existing;
      const messages = stalePending
        ? [
            { role: "user", content: existing[0].content },
            { role: "assistant", content: payload.body },
          ]
        : [
            { role: "user", content: payload.quote || "Selected webpage text" },
            { role: "assistant", content: payload.body },
          ];
      conversations[key] = messageRecord(payload, messages);
      return messages;
    });
  }

  function appendFollowUp(payload, question, answer) {
    const key = conversationKey(payload);
    if (!key) return Promise.resolve([]);
    return mutate(conversationsKey, (conversations) => {
      const history = conversations[key]?.messages || [];
      const messages = [
        ...history,
        { role: "user", content: question },
        { role: "assistant", content: answer },
      ];
      conversations[key] = messageRecord(payload, messages);
      return messages;
    });
  }

  function clearConversation(payload) {
    const key = conversationKey(payload);
    if (!key) return Promise.resolve();
    return mutate(conversationsKey, (conversations) => {
      delete conversations[key];
    });
  }

  async function allConversations() {
    const { [conversationsKey]: conversations = {} } =
      await chrome.storage.local.get(conversationsKey);
    return conversations;
  }

  async function readThread(documentId) {
    const key = threadKey(documentId);
    if (!key) return null;
    const { [threadsKey]: threads = {} } =
      await chrome.storage.local.get(threadsKey);
    return threads[key] || null;
  }

  function upsertThread(payload) {
    const key = threadKey(payload.documentId);
    if (!key) return Promise.resolve(null);
    return mutate(threadsKey, (threads) => {
      const thread = threads[key] || {
        documentId: payload.documentId,
        documentTitle: payload.documentTitle,
        entries: [],
        scrollTop: 0,
        updatedAt: 0,
      };
      const entry = {
        conversationId: payload.conversationId,
        title: payload.title,
        body: payload.body,
        quote: payload.quote,
        context: payload.context,
        documentId: payload.documentId,
        documentTitle: payload.documentTitle,
        presentation: payload.presentation || "chat",
        updatedAt: Date.now(),
      };
      const index = thread.entries.findIndex(
        (item) => item.conversationId === entry.conversationId,
      );
      if (index >= 0)
        thread.entries[index] = { ...thread.entries[index], ...entry };
      else thread.entries.push(entry);
      thread.entries = thread.entries.slice(-50);
      thread.documentTitle = payload.documentTitle || thread.documentTitle;
      thread.updatedAt = Date.now();
      threads[key] = thread;
      return thread;
    });
  }

  function saveThreadScroll(documentId, scrollTop) {
    const key = threadKey(documentId);
    if (!key) return Promise.resolve();
    return mutate(threadsKey, (threads) => {
      if (threads[key]) threads[key].scrollTop = scrollTop;
    });
  }

  window.LeafReaderPanelStore = {
    allConversations,
    appendFollowUp,
    clearConversation,
    conversationKey,
    ensureInitialConversation,
    loadConversation,
    pending,
    readThread,
    saveThreadScroll,
    threadKey,
    upsertThread,
  };
})();
