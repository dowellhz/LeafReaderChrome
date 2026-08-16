import { requestAI } from "./ai-client.js";
import {
  deleteRecord,
  saveMarker,
  saveVocabularyDefinition,
  saveVocabularyOccurrence,
  syncReaderRecords,
  upsertRecord,
} from "./record-store.js";

const READER_URL = chrome.runtime.getURL("reader.html");
async function openReader(tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return;
  try {
    const article = await chrome.tabs.sendMessage(tab.id, {
      type: "CAPTURE_ARTICLE",
    });
    if (!article?.text) throw new Error("No readable content");
    await chrome.storage.session.set({ pendingArticle: article });
    await chrome.tabs.create({ url: READER_URL });
  } catch (error) {
    await chrome.storage.session.set({
      pendingError: "This page cannot be converted into reader mode.",
    });
    await chrome.tabs.create({ url: READER_URL });
  }
}

async function prepareLeafSidePanel(tabId) {
  if (!Number.isInteger(tabId)) return false;
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel.html",
      enabled: true,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function openLeafSidePanel(tab, payload, shouldOpen = false) {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId))
    throw new Error(
      "Chrome did not provide the current webpage tab for the Side Panel.",
    );
  // Navigation and content-script startup normally prepare the tab before a
  // selection is made. Start a final preparation request as a safeguard, but
  // call `open()` immediately so it remains within the selection click's
  // trusted user gesture.
  const preparing = prepareLeafSidePanel(tabId);
  // This is Chrome's supported content-script gesture hand-off: target the
  // sender's tab directly. Opening by window lost the gesture in some Chrome
  // builds even though it is otherwise a valid Side Panel API context.
  const opening = shouldOpen
    ? chrome.sidePanel
        .open({ tabId })
        .then(() => true)
        .catch(() => false)
    : null;
  await chrome.storage.session.set({
    leafReaderSidePanel: {
      tabId,
      payload: { ...payload, tabId },
      updatedAt: Date.now(),
    },
  });
  await preparing;
  if (opening && !(await opening))
    throw new Error(
      "Chrome could not open the Side Panel for this tab. Please try the AI action again after the page finishes loading.",
    );
}

async function clearLeafSidePanel(tabId, discardAnyPanel = false) {
  if (!Number.isInteger(tabId)) return;
  const { leafReaderSidePanel } = await chrome.storage.session.get(
    "leafReaderSidePanel",
  );
  if (discardAnyPanel || leafReaderSidePanel?.tabId === tabId)
    await chrome.storage.session.remove("leafReaderSidePanel");
}

async function collapseLeafSidePanel(tabId, discardAnyPanel = false) {
  if (!Number.isInteger(tabId)) return;
  await clearLeafSidePanel(tabId, discardAnyPanel);
  // Disabling a tab-specific panel closes it for the newly loaded or
  // activated page. The fresh content script will enable it again before the
  // next intentional selection action.
  await chrome.sidePanel
    .setOptions({ tabId, enabled: false })
    .catch(() => undefined);
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-reader") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await openReader(tab);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation starts a new reading context. Collapse the old result panel
  // once; the new content script prepares it lazily without reopening it.
  if (changeInfo.status === "loading") void collapseLeafSidePanel(tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void collapseLeafSidePanel(tabId, true);
});
const messageHandlers = {
  AI_REQUEST: (message) => requestAI(message),
  AI_CHAT: (message) => requestAI(message),
  AI_TEST: (message) => requestAI({ ...message, test: true }),
  async UPSERT_RECORD(message) {
    const record = await upsertRecord(message.collection, message.record);
    return { ok: true, record };
  },
  async DELETE_RECORD(message) {
    await deleteRecord(message.collection, message.id);
    return { ok: true };
  },
  async SAVE_MARKER(message) {
    const record = await saveMarker(message.record);
    return { ok: true, record };
  },
  async SAVE_VOCABULARY_OCCURRENCE(message) {
    const result = await saveVocabularyOccurrence(message.record);
    return { ok: true, ...result };
  },
  async SAVE_VOCABULARY_DEFINITION(message) {
    const record = await saveVocabularyDefinition(
      message.lemma,
      message.definition,
    );
    return { ok: true, record };
  },
  async SYNC_READER_RECORDS(message) {
    const records = await syncReaderRecords(message.records || {});
    return { ok: true, ...records };
  },
  async OPEN_LEAF_SIDEPANEL(message, sender) {
    await openLeafSidePanel(sender.tab, message.payload, Boolean(message.open));
    return { ok: true };
  },
  async PREPARE_SIDE_PANEL(_message, sender) {
    const ok = await prepareLeafSidePanel(sender.tab?.id);
    return ok
      ? { ok: true }
      : {
          ok: false,
          error: "Chrome could not enable the Side Panel for this tab.",
        };
  },
  async PAGE_CHANGED(_message, sender) {
    await collapseLeafSidePanel(sender.tab?.id);
    return { ok: true };
  },
  async ANNOTATION_SAVED(message) {
    const tabId = Number(message.tabId);
    if (Number.isInteger(tabId)) {
      await chrome.tabs
        .sendMessage(tabId, {
          type: "ANNOTATION_SAVED",
          record: message.record,
        })
        .catch(() => undefined);
    }
    return { ok: true };
  },
  async OPEN_DOCUMENT_SOURCE(message) {
    const url = String(message.documentId || "").replace(/^web:/, "");
    if (/^https?:/i.test(url)) await chrome.tabs.create({ url });
    return { ok: true };
  },
  async OPEN_READER_FROM_SIDEPANEL() {
    const { leafReaderSidePanel } = await chrome.storage.session.get(
      "leafReaderSidePanel",
    );
    const tabId = leafReaderSidePanel?.tabId;
    if (!Number.isInteger(tabId)) {
      return {
        ok: false,
        error: "There is no active webpage associated with this Side Panel.",
      };
    }
    await openReader(await chrome.tabs.get(tabId));
    return { ok: true };
  },
  async OPEN_READER(_message, sender) {
    await openReader(sender.tab);
    return { ok: true };
  },
  async OPEN_ACTIVE_PAGE() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const page = tabs
      .filter((tab) => /^https?:/.test(tab.url || ""))
      .sort(
        (left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0),
      )[0];
    await openReader(page);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handler = messageHandlers[message?.type];
  if (!handler) return false;
  Promise.resolve(handler(message, sender))
    .then(respond)
    .catch((error) =>
      respond({ ok: false, error: error?.message || String(error) }),
    );
  return true;
});
