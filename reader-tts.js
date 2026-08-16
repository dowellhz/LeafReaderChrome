function preferredTtsLanguage(text = "") {
  const value = String(text || "");
  // Speech language must follow the text, not the AI/UI language. Otherwise an
  // English article in a Chinese Chrome UI gets read with a Chinese voice.
  if (/[\u3040-\u30ff]/.test(value)) return "ja-JP";
  if (/[\uac00-\ud7af]/.test(value)) return "ko-KR";
  if (/[\u3400-\u9fff]/.test(value)) return "zh-CN";
  return "en-US";
}
function populateVoices() {
  availableVoices = speechSynthesis.getVoices();
  const select = $("#ttsVoice");
  if (!select) return;
  const current = localStorage.getItem("leaf-tts-voice") || "";
  const language = preferredTtsLanguage(
    selected?.text || activeDocument?.text || $("#article")?.innerText,
  );
  const matching = availableVoices
    .filter((voice) =>
      voice.lang.toLowerCase().startsWith(language.slice(0, 2)),
    )
    .concat(
      availableVoices.filter(
        (voice) => !voice.lang.toLowerCase().startsWith(language.slice(0, 2)),
      ),
    );
  select.innerHTML = `<option value="">System default (${language})</option>${matching.map((voice) => `<option value="${escapeHtml(voice.voiceURI)}">${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}</option>`).join("")}`;
  select.value = matching.some((voice) => voice.voiceURI === current)
    ? current
    : "";
}
function sentenceQueue(text) {
  const value = cleanText(text);
  if (!value) return [];
  if (Intl.Segmenter)
    return [
      ...new Intl.Segmenter(preferredTtsLanguage(value), {
        granularity: "sentence",
      }).segment(value),
    ]
      .map((entry) => ({ text: entry.segment.trim(), range: null }))
      .filter((entry) => entry.text);
  return (
    value
      .match(/[^.!?。！？]+[.!?。！？]*|.+$/g)
      ?.map((part) => part.trim())
      .filter(Boolean) || []
  ).map((text) => ({ text, range: null }));
}
function articleSentenceQueue() {
  const root = $("#article");
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement.closest("mark,.search-hit")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  const chars = [];
  const map = [];
  let whitespace = false;
  for (const textNode of nodes)
    for (let offset = 0; offset < textNode.nodeValue.length; offset += 1) {
      const char = textNode.nodeValue[offset];
      if (/\s/.test(char)) {
        if (!whitespace) {
          chars.push(" ");
          map.push({ node: textNode, offset });
          whitespace = true;
        }
      } else {
        chars.push(char);
        map.push({ node: textNode, offset });
        whitespace = false;
      }
    }
  const rawText = chars.join("");
  const leading = rawText.length - rawText.trimStart().length;
  const text = rawText.trim();
  if (!text) return [];
  let fallbackOffset = 0;
  const segments = Intl.Segmenter
    ? [
        ...new Intl.Segmenter(preferredTtsLanguage(text), {
          granularity: "sentence",
        }).segment(text),
      ].map(({ segment, index }) => ({
        text: segment.trim(),
        start: index + segment.indexOf(segment.trim()),
      }))
    : (text.match(/[^.!?。！？]+[.!?。！？]*|.+$/g) || []).map((segment) => {
        const start = fallbackOffset + segment.indexOf(segment.trim());
        fallbackOffset += segment.length;
        return { text: segment.trim(), start };
      });
  return segments
    .filter((entry) => entry.text)
    .map((entry) => {
      const start = leading + entry.start;
      const end = start + entry.text.length;
      const first = map[start];
      const last = map[end - 1];
      let range = null;
      if (first && last) {
        range = document.createRange();
        range.setStart(first.node, first.offset);
        range.setEnd(last.node, last.offset + 1);
      }
      return { text: entry.text, range };
    });
}
function setTtsHighlight(range) {
  if (!window.CSS?.highlights || !window.Highlight) return;
  if (!range) {
    window.CSS.highlights.delete("leafreader-tts");
    activeTtsHighlight = null;
    return;
  }
  activeTtsHighlight = new Highlight(range);
  window.CSS.highlights.set("leafreader-tts", activeTtsHighlight);
  range.getBoundingClientRect &&
    range.startContainer.parentElement?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
}
function stopSpeaking(preservePosition = true) {
  if (
    preservePosition &&
    ttsForDocument &&
    activeDocument &&
    ttsQueue.length &&
    ttsIndex < ttsQueue.length
  ) {
    activeDocument.ttsSentenceIndex = ttsIndex;
    dbPut(activeDocument);
  }
  speechSynthesis.cancel();
  speaking = false;
  ttsPaused = false;
  ttsQueue = [];
  ttsIndex = 0;
  ttsForDocument = false;
  setTtsHighlight(null);
  $("#ttsToggle").classList.remove("active");
}
function speakNext() {
  if (!speaking || ttsPaused || ttsIndex >= ttsQueue.length) {
    if (ttsIndex >= ttsQueue.length) {
      if (ttsForDocument && activeDocument) {
        activeDocument.ttsSentenceIndex = 0;
        dbPut(activeDocument);
      }
      stopSpeaking(false);
    }
    return;
  }
  if (ttsForDocument && activeDocument) {
    activeDocument.ttsSentenceIndex = ttsIndex;
    dbPut(activeDocument);
  }
  const sentence = ttsQueue[ttsIndex];
  setTtsHighlight(sentence.range);
  utterance = new SpeechSynthesisUtterance(sentence.text);
  utterance.lang = preferredTtsLanguage(sentence.text);
  utterance.rate = Number(localStorage.getItem("leaf-tts-rate") || 1);
  const voice = availableVoices.find(
    (item) => item.voiceURI === localStorage.getItem("leaf-tts-voice"),
  );
  if (voice) utterance.voice = voice;
  utterance.onend = () => {
    if (!speaking || ttsPaused) return;
    ttsIndex += 1;
    speakNext();
  };
  utterance.onerror = (event) => {
    if (event.error !== "interrupted" && event.error !== "canceled") {
      ttsIndex += 1;
      speakNext();
    }
  };
  speechSynthesis.speak(utterance);
}
function speak(text = selected?.text || $("#article").innerText) {
  const selection = selected?.text;
  stopSpeaking();
  ttsForDocument = !selection;
  ttsQueue = selection ? sentenceQueue(selection) : articleSentenceQueue();
  if (!ttsQueue.length) return;
  if (ttsForDocument)
    ttsIndex = Math.min(
      Math.max(0, Number(activeDocument?.ttsSentenceIndex || 0)),
      ttsQueue.length - 1,
    );
  speaking = true;
  $("#ttsToggle").classList.add("active");
  speakNext();
  clearSelection();
}
function toggleSpeaking() {
  if (!speaking) {
    speak();
    return;
  }
  if (speechSynthesis.paused || ttsPaused) {
    ttsPaused = false;
    speechSynthesis.resume();
    return;
  }
  ttsPaused = true;
  speechSynthesis.pause();
}
function highlightSearch() {
  $("#article")
    .querySelectorAll("mark.search-hit")
    .forEach((node) =>
      node.replaceWith(document.createTextNode(node.textContent)),
    );
  const term = $("#inDocumentSearch").value.trim();
  searchHits = [];
  matchIndex = -1;
  if (!term) {
    $("#searchCount").textContent = "";
    return;
  }
  const walker = document.createTreeWalker(
    $("#article"),
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (n) =>
        n.parentElement.closest("mark")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  );
  let node;
  const nodes = [];
  while ((node = walker.nextNode())) nodes.push(node);
  nodes.reverse().forEach((textNode) => {
    const haystack = textNode.nodeValue.toLowerCase();
    const needle = term.toLowerCase();
    let index = haystack.lastIndexOf(needle);
    while (index >= 0) {
      const after = textNode.splitText(index + term.length);
      const match = textNode.splitText(index);
      const mark = document.createElement("mark");
      mark.className = "search-hit";
      match.parentNode.replaceChild(mark, match);
      mark.append(match);
      searchHits.unshift(mark);
      index = textNode.nodeValue.toLowerCase().lastIndexOf(needle, index - 1);
      if (!after) break;
    }
  });
  $("#searchCount").textContent = `${searchHits.length} found`;
  if (searchHits.length) moveMatch(1);
}
function moveMatch(delta) {
  if (!searchHits.length) return;
  searchHits.forEach((hit) => hit.classList.remove("current"));
  matchIndex = (matchIndex + delta + searchHits.length) % searchHits.length;
  searchHits[matchIndex].classList.add("current");
  searchHits[matchIndex].scrollIntoView({
    block: "center",
    behavior: "smooth",
  });
}
