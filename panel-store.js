/* URL-scoped panel data is stored one conversation/thread per Chrome storage
 * key. This keeps large reading trails from rewriting one global object. */
(() => {
  const prefix = "leafreader:panel:";
  const conversationPrefix = `${prefix}conversation:`;
  const threadPrefix = `${prefix}thread:`;
  const migrationKey = `${prefix}migration-v2`;
  const queues = new Map();
  let migration;

  const conversationKey = (payload) =>
    payload?.conversationId ? `conversation:${payload.conversationId}` : "";
  const threadKey = (documentId) => (documentId ? `thread:${documentId}` : "");
  const conversationStorageKey = (payload) =>
    `${conversationPrefix}${payload.conversationId}`;
  const threadStorageKey = (documentId) =>
    `${threadPrefix}${encodeURIComponent(documentId)}`;
  const pending = (value) =>
    /^(?:thinking|loading|正在|处理中|请求中|请稍候)/i.test(
      String(value || "").trim(),
    );

  function mutate(key, update) {
    const previous = queues.get(key) || Promise.resolve();
    const task = previous.then(async () => {
      const { [key]: stored } = await chrome.storage.local.get(key);
      const value = structuredClone(stored || {});
      const result = await update(value);
      await chrome.storage.local.set({ [key]: value });
      return result;
    });
    queues.set(
      key,
      task.catch(() => undefined),
    );
    return task;
  }

  async function migrate() {
    if (migration) return migration;
    migration = (async () => {
      const {
        [migrationKey]: migrated,
        aiConversations = {},
        sidePanelThreads = {},
      } = await chrome.storage.local.get([
        migrationKey,
        "aiConversations",
        "sidePanelThreads",
      ]);
      if (migrated) return;
      const next = { [migrationKey]: Date.now() };
      Object.entries(aiConversations).forEach(([key, value]) => {
        const id = key.replace(/^conversation:/, "");
        next[`${conversationPrefix}${id}`] = value;
      });
      Object.entries(sidePanelThreads).forEach(([key, value]) => {
        const id = key.replace(/^thread:/, "");
        next[threadStorageKey(id)] = value;
      });
      await chrome.storage.local.set(next);
      await chrome.storage.local.remove([
        "aiConversations",
        "sidePanelThreads",
      ]);
    })();
    return migration;
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
    if (!payload?.conversationId || payload.conversationCleared) return [];
    await migrate();
    const key = conversationStorageKey(payload);
    const { [key]: conversation } = await chrome.storage.local.get(key);
    return conversation?.messages || [];
  }

  async function loadConversationMap(entries) {
    await migrate();
    const keys = [
      ...new Set(entries.map((entry) => entry.conversationId).filter(Boolean)),
    ].map((id) => `${conversationPrefix}${id}`);
    const stored = keys.length ? await chrome.storage.local.get(keys) : {};
    return Object.fromEntries(
      entries.map((entry) => [
        entry.conversationId,
        stored[`${conversationPrefix}${entry.conversationId}`]?.messages || [],
      ]),
    );
  }

  async function ensureInitialConversation(payload) {
    if (!payload?.conversationId || !payload.body || pending(payload.body)) {
      return loadConversation(payload);
    }
    await migrate();
    const key = conversationStorageKey(payload);
    return mutate(key, (conversation) => {
      const existing = conversation.messages || [];
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
      Object.assign(conversation, messageRecord(payload, messages));
      return messages;
    });
  }

  async function appendFollowUp(payload, question, answer) {
    if (!payload?.conversationId) return [];
    await migrate();
    const key = conversationStorageKey(payload);
    return mutate(key, (conversation) => {
      const messages = [
        ...(conversation.messages || []),
        { role: "user", content: question },
        { role: "assistant", content: answer },
      ];
      Object.assign(conversation, messageRecord(payload, messages));
      return messages;
    });
  }

  async function clearConversation(payload) {
    if (!payload?.conversationId) return;
    await migrate();
    await chrome.storage.local.remove(conversationStorageKey(payload));
  }

  async function readThread(documentId) {
    if (!documentId) return null;
    await migrate();
    const key = threadStorageKey(documentId);
    return (await chrome.storage.local.get(key))[key] || null;
  }

  async function upsertThread(payload) {
    if (!payload?.documentId) return null;
    await migrate();
    const key = threadStorageKey(payload.documentId);
    return mutate(key, (thread) => {
      Object.assign(thread, {
        documentId: payload.documentId,
        documentTitle: payload.documentTitle || thread.documentTitle,
        entries: thread.entries || [],
        scrollTop: thread.scrollTop || 0,
      });
      const entry = { ...payload, updatedAt: Date.now() };
      const index = thread.entries.findIndex(
        (item) => item.conversationId === entry.conversationId,
      );
      if (index >= 0)
        thread.entries[index] = { ...thread.entries[index], ...entry };
      else thread.entries.push(entry);
      thread.entries = thread.entries.slice(-50);
      thread.updatedAt = Date.now();
      return thread;
    });
  }

  async function saveThreadScroll(documentId, scrollTop) {
    if (!documentId) return;
    await migrate();
    const key = threadStorageKey(documentId);
    await mutate(key, (thread) => {
      if (thread.documentId) thread.scrollTop = scrollTop;
    });
  }

  async function exportData() {
    await migrate();
    const stored = await chrome.storage.local.get(null);
    const aiConversations = {};
    const sidePanelThreads = {};
    Object.entries(stored).forEach(([key, value]) => {
      if (key.startsWith(conversationPrefix)) {
        aiConversations[
          `conversation:${key.slice(conversationPrefix.length)}`
        ] = value;
      }
      if (key.startsWith(threadPrefix)) {
        const id = decodeURIComponent(key.slice(threadPrefix.length));
        sidePanelThreads[`thread:${id}`] = value;
      }
    });
    return { aiConversations, sidePanelThreads };
  }

  async function replaceData(data) {
    await migrate();
    const stored = await chrome.storage.local.get(null);
    const existing = Object.keys(stored).filter((key) =>
      key.startsWith(prefix),
    );
    if (existing.length) await chrome.storage.local.remove(existing);
    const next = { [migrationKey]: Date.now() };
    Object.entries(data.aiConversations || {}).forEach(([key, value]) => {
      next[`${conversationPrefix}${key.replace(/^conversation:/, "")}`] = value;
    });
    Object.entries(data.sidePanelThreads || {}).forEach(([key, value]) => {
      const id = key.replace(/^thread:/, "");
      next[threadStorageKey(id)] = value;
    });
    await chrome.storage.local.set(next);
  }

  window.LeafReaderPanelStore = {
    appendFollowUp,
    clearConversation,
    conversationKey,
    ensureInitialConversation,
    exportData,
    loadConversation,
    loadConversationMap,
    migrate,
    pending,
    readThread,
    replaceData,
    saveThreadScroll,
    threadKey,
    upsertThread,
  };
})();
