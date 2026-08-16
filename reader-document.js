function sanitizeHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";
  template.content
    .querySelectorAll(
      "script,style,iframe,object,embed,form,button,nav,aside,footer,header",
    )
    .forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) =>
    [...node.attributes].forEach((attribute) => {
      const isUnsafeUrl =
        ["href", "src", "xlink:href"].includes(attribute.name) &&
        /^\s*(?:javascript|vbscript):/i.test(attribute.value);
      if (
        /^on/i.test(attribute.name) ||
        attribute.name === "style" ||
        isUnsafeUrl
      )
        node.removeAttribute(attribute.name);
    }),
  );
  return template.innerHTML;
}
function setAssistantResult(value, markdown = true) {
  const panel = $("#assistantResult");
  panel.innerHTML = markdown
    ? window.LeafReaderMarkdown.markdown(value).replace(
        /\[S(\d+)\]/g,
        '<button class="source-cite" data-source="$1">[S$1]</button>',
      )
    : `<p>${escapeHtml(value)}</p>`;
  panel.querySelectorAll("[data-source]").forEach(
    (button) =>
      (button.onclick = () => {
        const source = activeSources[Number(button.dataset.source) - 1];
        if (!source) return;
        const range = rangeForQuote(source.slice(0, 220));
        if (!range) {
          showToast("This source could not be located in the current webpage.");
          return;
        }
        if (window.CSS?.highlights && window.Highlight)
          window.CSS.highlights.set("leafreader-source", new Highlight(range));
        range.startContainer.parentElement?.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
      }),
  );
}

async function openDocument(id) {
  stopSpeaking();
  const doc = await dbGet(id);
  if (!doc) return;
  activeDocument = { ...doc, lastOpenedAt: Date.now() };
  await dbPut(activeDocument);
  $("#readerTitle").textContent = doc.title;
  $("#readerMeta").textContent = doc.byline || doc.sourceUrl || doc.type || "";
  showView("reader");
  $("#article").style.setProperty(
    "--text-size",
    `${localStorage.getItem("leaf-font-size") || 18}px`,
  );
  $("#article").style.setProperty(
    "--text-width",
    `${localStorage.getItem("leaf-text-width") || 720}px`,
  );
  $("#article").style.setProperty(
    "--leading",
    localStorage.getItem("leaf-leading") || 1.8,
  );
  $("#fontSize").value = localStorage.getItem("leaf-font-size") || 18;
  $("#textWidth").value = localStorage.getItem("leaf-text-width") || 720;
  $("#lineHeight").value = localStorage.getItem("leaf-leading") || 1.8;
  $("#article").innerHTML = sanitizeHtml(
    doc.html || `<p>${escapeHtml(doc.text)}</p>`,
  );
  restoreAnnotations();
  window.scrollTo({
    top: Math.max(
      0,
      (doc.progress || 0) *
        Math.max(0, document.documentElement.scrollHeight - innerHeight),
    ),
    behavior: "instant",
  });
}
let progressSaveTimer = 0;
function updateProgress() {
  if (!activeDocument || !$("#readerView").classList.contains("active")) return;
  const total = Math.max(
    1,
    document.documentElement.scrollHeight - innerHeight,
  );
  activeDocument.progress = Math.min(1, Math.max(0, scrollY / total));
  activeDocument.lastOpenedAt = Date.now();
  $("#progressBar").style.width = `${activeDocument.progress * 100}%`;
}
function saveProgress() {
  if (!activeDocument || !$("#readerView").classList.contains("active")) return;
  updateProgress();
  clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(() => void dbPut(activeDocument), 350);
}
function flushProgress() {
  updateProgress();
  clearTimeout(progressSaveTimer);
  if (activeDocument) return dbPut(activeDocument);
  return Promise.resolve();
}
let scrollTick = 0;
addEventListener(
  "scroll",
  () => {
    cancelAnimationFrame(scrollTick);
    scrollTick = requestAnimationFrame(saveProgress);
  },
  { passive: true },
);
addEventListener("pagehide", () => void flushProgress());

function rangeForQuote(quote, occurrence = 0, root = $("#article")) {
  const target = cleanText(quote);
  if (!target) return null;
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement.closest("mark[data-annotation-id]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  const full = nodes.map((node) => node.nodeValue).join("");
  let cursor = 0;
  let found = -1;
  for (let i = 0; i <= occurrence; i++) {
    found = full.toLowerCase().indexOf(target.toLowerCase(), cursor);
    if (found < 0) return null;
    cursor = found + target.length;
  }
  let startNode,
    endNode,
    startOffset,
    endOffset,
    position = 0;
  for (const textNode of nodes) {
    const next = position + textNode.nodeValue.length;
    if (!startNode && found >= position && found <= next) {
      startNode = textNode;
      startOffset = found - position;
    }
    if (startNode && found + target.length <= next) {
      endNode = textNode;
      endOffset = found + target.length - position;
      break;
    }
    position = next;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}
function wrapRange(range, className, id) {
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
  );
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!range.intersectsNode(node) || !node.nodeValue.trim()) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end =
      node === range.endContainer ? range.endOffset : node.nodeValue.length;
    if (end > start) targets.push({ node, start, end });
  }
  if (
    range.startContainer.nodeType === Node.TEXT_NODE &&
    !targets.some((item) => item.node === range.startContainer)
  )
    targets.unshift({
      node: range.startContainer,
      start: range.startOffset,
      end:
        range.endContainer === range.startContainer
          ? range.endOffset
          : range.startContainer.nodeValue.length,
    });
  targets.reverse().forEach(({ node, start, end }) => {
    let mid = node;
    if (end < mid.nodeValue.length) mid = mid.splitText(end);
    if (start) mid = mid.splitText(start);
    const span = document.createElement("mark");
    span.className = className;
    span.dataset.annotationId = id;
    mid.parentNode.insertBefore(span, mid);
    span.append(mid);
  });
}
function restoreAnnotations() {
  const classForAnnotation = (kind) =>
    ({
      note: "leaf-note",
      translation: "leaf-translation",
      dictionary: "leaf-dictionary",
      explanation: "leaf-explanation",
    })[kind] || "leaf-highlight";
  annotations
    .filter((item) => item.documentId === activeDocument.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach((item) => {
      const range = rangeForQuote(item.quote);
      if (range) wrapRange(range, classForAnnotation(item.kind), item.id);
    });
  vocabulary
    .filter((item) => item.documentId === activeDocument.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach((item) => {
      const range = rangeForQuote(item.word);
      if (range) wrapRange(range, "leaf-word", item.id);
    });
}
