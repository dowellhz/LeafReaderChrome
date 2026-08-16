const clean = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();
const lemmaFor = (value) => {
  const word = clean(value)
    .toLocaleLowerCase()
    .replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, "");
  if (!/^[a-z][a-z'-]*$/i.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5)
    return word.slice(0, -3).replace(/([b-df-hj-np-tv-z])\1$/, "$1");
  if (word.endsWith("ed") && word.length > 4)
    return word.slice(0, -2).replace(/([b-df-hj-np-tv-z])\1$/, "$1");
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 3 && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
};
const extensionContextIsAlive = () => {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch (_) {
    return false;
  }
};
const sendToExtension = (message) => {
  if (!extensionContextIsAlive())
    return Promise.resolve({ ok: false, contextInvalidated: true });
  return chrome.runtime.sendMessage(message).catch((error) => {
    if (/Extension context invalidated/i.test(error?.message || ""))
      return { ok: false, contextInvalidated: true };
    throw error;
  });
};
const localStorageCall = async (callback) => {
  if (!extensionContextIsAlive())
    throw new Error(
      "LeafReader was updated. Refresh this webpage, then try again.",
    );
  return callback();
};
const ignored =
  'script,style,noscript,nav,aside,footer,header,form,button,iframe,svg,canvas,[aria-hidden="true"],.advertisement,.ads,.ad';
const visibleText = (element) =>
  clean(element?.innerText || element?.textContent);
function score(element) {
  const text = visibleText(element);
  if (text.length < 180) return -Infinity;
  const links = [...element.querySelectorAll("a")].reduce(
    (n, a) => n + visibleText(a).length,
    0,
  );
  const punctuation = (text.match(/[.!?。！？]/g) || []).length;
  return (
    text.length * (1 - Math.min(0.8, links / text.length)) + punctuation * 35
  );
}
function capture() {
  const candidates = [
    ...document.querySelectorAll(
      'article,main,[role="main"],.post,.article,.entry-content,.content',
    ),
  ];
  const root =
    candidates.sort((a, b) => score(b) - score(a))[0] || document.body;
  const clone = root.cloneNode(true);
  clone.querySelectorAll(ignored).forEach((node) => node.remove());
  clone.querySelectorAll("img").forEach((image) => {
    const src = image.currentSrc || image.src;
    if (src) image.setAttribute("src", src);
    image.removeAttribute("srcset");
  });
  clone
    .querySelectorAll("a")
    .forEach((link) => link.setAttribute("href", link.href || "#"));
  const title = clean(
    document.querySelector('meta[property="og:title"]')?.content ||
      document.title ||
      location.hostname,
  );
  return {
    id: `web:${location.href}`,
    sourceUrl: location.href,
    title,
    byline: clean(
      document.querySelector('[rel="author"],.author,[class*="byline"]')
        ?.textContent,
    ),
    html: clone.innerHTML,
    text: visibleText(clone),
    capturedAt: Date.now(),
  };
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "CAPTURE_ARTICLE") respond(capture());
  if (message.type === "ANNOTATION_SAVED") {
    paintRecord(message.record);
    respond({ ok: true });
  }
});
document.addEventListener("keydown", (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.key.toLowerCase() === "r"
  ) {
    event.preventDefault();
    sendToExtension({ type: "OPEN_READER" });
  }
});

// Web-page companion: the UI is isolated in a shadow root so it never inherits
// (or changes) a site's CSS. It mirrors LeafReader's selection-first workflow.
let documentId = `web:${location.href}`;
let documentTitle = clean(
  document.querySelector('meta[property="og:title"]')?.content ||
    document.title ||
    location.hostname,
);
let observedUrl = location.href;
let selectedText = "";
let selectedContext = "";
let selectedRange = null;
const highlightSets = new Map();
let paintedRanges = [];
const host = document.createElement("div");
host.id = "leafreader-chrome-root";
const shadow = host.attachShadow({ mode: "closed" });
const toolbarCss = [
  ":host{all:initial}",
  ".toolbar{position:fixed;z-index:2147483647;display:flex;align-items:center;gap:2px;padding:4px;background:#293a31;border:1px solid #435649;border-radius:9px;box-shadow:0 8px 26px #0005;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
  ".toolbar[hidden]{display:none}",
  ".toolbar button{appearance:none;border:0;border-radius:6px;background:transparent;color:#fff;padding:7px 9px;white-space:nowrap;font:600 12px/1.2 inherit;cursor:pointer}",
  ".toolbar button:hover{background:#ffffff1f}",
  ".toolbar .star{color:#f5df83}",
].join("");
shadow.innerHTML = `<style>${toolbarCss}</style><div class="toolbar" hidden><button data-action="translate">翻译</button><button data-action="dictionary">词典</button><button data-action="word">保存单词</button><button data-action="highlight">高亮</button><button data-action="note">笔记</button><button data-action="speak">朗读</button><button data-action="ai" class="star">✦ AI</button></div>`;
document.documentElement.append(host);
const toolbar = shadow.querySelector(".toolbar");
// Enabling is silent: it does not display the side panel. Doing it once on
// page readiness removes the first-click race between a selection action and
// Chrome's tab-specific Side Panel setup.
void sendToExtension({ type: "PREPARE_SIDE_PANEL" });

const excludedText =
  'script,style,noscript,textarea,input,select,option,[contenteditable="true"],#leafreader-chrome-root';
const textIndex = () => {
  const nodes = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.parentElement?.closest(excludedText)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  const chars = [];
  const map = [];
  let whitespace = false;
  for (const textNode of nodes)
    for (let offset = 0; offset < textNode.nodeValue.length; offset += 1) {
      const character = textNode.nodeValue[offset];
      if (/\s/.test(character)) {
        if (!whitespace) {
          chars.push(" ");
          map.push({ node: textNode, offset });
          whitespace = true;
        }
      } else {
        chars.push(character);
        map.push({ node: textNode, offset });
        whitespace = false;
      }
    }
  return { text: chars.join(""), map };
};
const boundaryPosition = (index, node, offset, end = false) => {
  if (node?.nodeType !== Node.TEXT_NODE) return -1;
  if (end) {
    for (let i = index.map.length - 1; i >= 0; i -= 1)
      if (index.map[i].node === node && index.map[i].offset < offset)
        return i + 1;
  } else
    for (let i = 0; i < index.map.length; i += 1)
      if (index.map[i].node === node && index.map[i].offset >= offset) return i;
  return -1;
};
const createAnchor = (range) => {
  const exact = clean(range?.toString());
  if (!exact) return null;
  const index = textIndex();
  let start = boundaryPosition(index, range.startContainer, range.startOffset);
  let end = boundaryPosition(index, range.endContainer, range.endOffset, true);
  if (start < 0 || end <= start) {
    start = index.text.toLocaleLowerCase().indexOf(exact.toLocaleLowerCase());
    end = start < 0 ? -1 : start + exact.length;
  }
  if (start < 0) return { exact, prefix: "", suffix: "", position: -1 };
  return {
    exact,
    prefix: index.text.slice(Math.max(0, start - 80), start),
    suffix: index.text.slice(end, end + 80),
    position: start,
  };
};
const rangeForAnchor = (anchor, index = textIndex()) => {
  const exact = clean(anchor?.exact);
  if (!exact) return null;
  const haystack = index.text.toLocaleLowerCase();
  const needle = exact.toLocaleLowerCase();
  const candidates = [];
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    candidates.push(at);
    at = haystack.indexOf(needle, at + Math.max(1, needle.length));
  }
  if (!candidates.length) return null;
  const best = candidates.sort((left, right) => {
    const score = (position) =>
      (anchor.prefix &&
      index.text.slice(
        Math.max(0, position - anchor.prefix.length),
        position,
      ) === anchor.prefix
        ? 10000
        : 0) +
      (anchor.suffix &&
      index.text.slice(
        position + exact.length,
        position + exact.length + anchor.suffix.length,
      ) === anchor.suffix
        ? 10000
        : 0) -
      Math.abs(position - Number(anchor.position || 0));
    return score(right) - score(left);
  })[0];
  const first = index.map[best];
  const last = index.map[best + exact.length - 1];
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
};
