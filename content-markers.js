const rangeAtPoint = (x, y) =>
  document.caretRangeFromPoint?.(x, y) ||
  (() => {
    const position = document.caretPositionFromPoint?.(x, y);
    if (!position) return null;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  })();
const openMarkedRecord = (record) => {
  const title =
    {
      translation: "Translation",
      dictionary: "单词释义",
      explanation: "AI explanation",
      note: "Note",
      word: "Vocabulary",
      highlight: "Highlight",
    }[record.kind] || "LeafReader";
  const payload = {
    mode: "result",
    title,
    body: record.note || record.definition || "Saved webpage marker.",
    quote: record.quote || record.word || "",
    context: record.context || "",
    documentId,
    documentTitle,
    presentation:
      record.presentation ||
      (record.kind === "dictionary" ? "dictionary" : "chat"),
  };
  if (record.conversationId)
    Object.assign(payload, {
      conversationId: record.conversationId,
      restoreThread: true,
    });
  void sendToExtension({ type: "OPEN_LEAF_SIDEPANEL", open: true, payload });
};
document.addEventListener(
  "click",
  (event) => {
    if (event.button !== 0 || !window.getSelection()?.isCollapsed) return;
    const point = rangeAtPoint(event.clientX, event.clientY);
    if (!point) return;
    const hit = [...paintedRanges].reverse().find(({ range }) => {
      try {
        return range.isPointInRange(point.startContainer, point.startOffset);
      } catch (_) {
        return false;
      }
    });
    if (!hit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openMarkedRecord(hit.record);
  },
  true,
);
restoreRecords().catch(() => {});
let restoreTimer = 0;
let idleRestore = 0;
const scheduleRestore = () => {
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => {
    const run = () => restoreRecords().catch(() => {});
    if ("requestIdleCallback" in window) {
      window.cancelIdleCallback?.(idleRestore);
      idleRestore = requestIdleCallback(run, { timeout: 1600 });
    } else {
      run();
    }
  }, 700);
};
const observer = new MutationObserver((changes) => {
  const changedPageContent = changes.some(
    (change) =>
      change.type === "childList" &&
      !host.contains(change.target) &&
      [...change.addedNodes, ...change.removedNodes].some(
        (node) => node !== host && !host.contains(node),
      ),
  );
  if (!changedPageContent) return;
  if (location.href !== observedUrl) refreshIdentity();
  scheduleRestore();
});
observer.observe(document.body, {
  childList: true,
  subtree: true,
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.annotations || changes.vocabulary)) {
    scheduleRestore();
  }
});
const refreshIdentity = () => {
  if (location.href !== observedUrl) {
    observedUrl = location.href;
    documentId = `web:${location.href}`;
    documentTitle = clean(
      document.querySelector('meta[property="og:title"]')?.content ||
        document.title ||
        location.hostname,
    );
    void sendToExtension({ type: "PAGE_CHANGED" });
    void restoreRecords();
  }
};
addEventListener("popstate", refreshIdentity);
addEventListener("hashchange", refreshIdentity);
