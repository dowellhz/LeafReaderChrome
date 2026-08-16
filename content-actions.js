const showToolbar = () => {
  const selection = window.getSelection();
  const text = clean(selection?.toString());
  if (
    !text ||
    selection.rangeCount === 0 ||
    text.length > 2500 ||
    selection.anchorNode?.parentElement?.closest?.(
      'input,textarea,[contenteditable="true"]',
    )
  ) {
    toolbar.hidden = true;
    return;
  }
  const range = selection.getRangeAt(0);
  if (!document.body.contains(range.commonAncestorContainer)) return;
  selectedText = text;
  selectedRange = range.cloneRange();
  selectedContext = clean(
    range.commonAncestorContainer.parentElement?.closest(
      "p,li,blockquote,article,main,div",
    )?.innerText || "",
  ).slice(0, 500);
  const rect = range.getBoundingClientRect();
  toolbar.style.left = `${Math.max(9, Math.min(innerWidth - 390, rect.left + rect.width / 2 - 138))}px`;
  toolbar.style.top = `${Math.max(9, rect.top - 46)}px`;
  toolbar.hidden = false;
};
let selectionTimer = 0;
const scheduleToolbar = () => {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(showToolbar, 80);
};
// Capture phase survives pages that stop propagation on mouseup. The
// selectionchange fallback also covers double-click and keyboard selection.
document.addEventListener("mouseup", scheduleToolbar, true);
document.addEventListener("selectionchange", scheduleToolbar);
document.addEventListener("keyup", (event) => {
  if (event.key === "Escape") {
    toolbar.hidden = true;
    return;
  }
  if (
    event.shiftKey ||
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
  )
    scheduleToolbar();
});
toolbar.addEventListener("mousedown", (event) => event.preventDefault());
const askAI = async (instruction) => {
  const result = await sendToExtension({
    type: "AI_REQUEST",
    instruction,
    text: selectedText,
    context: selectedContext,
  });
  if (!result?.ok)
    throw new Error(
      result?.error || "Extension background returned no response.",
    );
  return result.content;
};
const addVisualHighlight = (record) => {
  paintRange(record, selectedRange);
};
const saveSelectionMarker = async (kind, extras = {}) =>
  localStorageCall(async () => {
    const anchor = createAnchor(selectedRange);
    const record = createRecord(kind, { anchor, favorite: false, ...extras });
    const result = await sendToExtension({ type: "SAVE_MARKER", record });
    if (!result?.ok) throw new Error(result?.error || "Could not save marker.");
    return result.record;
  });
async function handleAction(action) {
  if (!selectedText) return;
  // Dictionary lookup is useful for a word or compact phrase. Treat a
  // paragraph-sized accidental lookup as translation so the reader never
  // receives a misleading pronunciation/word-usage card for an article.
  if (action === "dictionary" && selectedText.length > 160)
    action = "translate";
  if (action === "highlight") {
    const record = createRecord("highlight");
    await save("annotations", record);
    addVisualHighlight(record);
    display(
      "Highlight saved",
      "This highlight is saved to your LeafReader notes.",
      selectedText,
    );
    clearSelection();
    return;
  }
  if (action === "note") {
    sendToExtension({
      type: "OPEN_LEAF_SIDEPANEL",
      payload: {
        mode: "note",
        title: "Add a note",
        quote: selectedText,
        documentId,
        documentTitle,
        context: selectedContext,
        anchor: createAnchor(selectedRange),
      },
    });
    clearSelection();
    return;
  }
  if (action === "word") {
    const { record, created } = await saveWord();
    addVisualHighlight(record);
    display(
      created ? "Saved to vocabulary" : "Vocabulary updated",
      created
        ? "已加入个人词库。点击“词典”可用 AI 补全中文释义；词条会在复习页按间隔重复出现。"
        : `已记录第 ${record.occurrences} 次出现，并保留新的阅读上下文。`,
      selectedText,
    );
    clearSelection();
    return;
  }
  if (action === "speak") {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(selectedText);
    utterance.lang = /[\u3400-\u9fff]/.test(selectedText) ? "zh-CN" : "en-US";
    speechSynthesis.speak(utterance);
    display(
      "Read aloud",
      "LeafReader is reading the selected text aloud.",
      selectedText,
    );
    clearSelection();
    return;
  }
  if (action === "dictionary") {
    const conversationId = crypto.randomUUID();
    const marker = await saveSelectionMarker("dictionary", {
      conversationId,
      presentation: "dictionary",
    });
    addVisualHighlight(marker);
    display("单词释义", "正在按上下文解释…", selectedText, {
      conversationId,
      presentation: "dictionary",
    });
    try {
      const answer = await askAI(
        "Explain this English word or short phrase for a Chinese learner. Use concise Markdown with these sections: ## 发音 (UK and US IPA if known), one-line contextual Chinese meaning, ## 常见用法 (1–3 natural English examples with Chinese explanations), and ## 词性. Explain the selected text in its reading context; do not write a long essay.",
      );
      await saveDefinition(selectedText, answer);
      display("单词释义", answer, selectedText, {
        conversationId,
        presentation: "dictionary",
      });
    } catch (_) {
      // AI is optional. Keep a useful no-key fallback, but make its limitation explicit.
      try {
        const response = await fetch(
          `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(selectedText)}`,
        );
        if (!response.ok) throw new Error();
        const [entry] = await response.json();
        const definitions = (entry.meanings || [])
          .slice(0, 3)
          .map(
            (meaning) =>
              `${meaning.partOfSpeech}: ${meaning.definitions?.[0]?.definition || ""}`,
          )
          .join("\n");
        const fallback = `AI 未配置或不可用，以下为英文词典释义。\n${entry.phonetic || ""}\n${definitions}`;
        await saveDefinition(selectedText, fallback);
        display(entry.word || "English dictionary", fallback, selectedText, {
          conversationId,
          presentation: "dictionary",
        });
      } catch (_) {
        display(
          "单词释义",
          "AI 未配置或不可用，且没有找到在线英文词典条目。请检查 AI 设置，或选择单个英文单词。",
          selectedText,
          { conversationId, presentation: "dictionary" },
        );
      }
    }
    clearSelection();
    return;
  }
  const conversationId = crypto.randomUUID();
  const kind = action === "translate" ? "translation" : "explanation";
  const marker = await saveSelectionMarker(kind, {
    conversationId,
    presentation: "chat",
  });
  addVisualHighlight(marker);
  const title = action === "translate" ? "Translation" : "AI explanation";
  display(title, "Thinking…", selectedText, { conversationId });
  try {
    const instruction =
      action === "translate"
        ? "Translate every sentence in the selected text completely and in order. Do not summarize, omit, or explain only selected keywords. Preserve paragraph breaks. Return only the translation unless a brief clarification is essential."
        : "Explain the meaning in context, useful vocabulary or grammar, and the author’s likely intent.";
    display(title, await askAI(instruction), selectedText, {
      conversationId,
    });
  } catch (error) {
    display(
      title,
      `Could not reach the AI provider: ${error.message}`,
      selectedText,
      { conversationId },
    );
  }
  clearSelection();
}
const startToolbarAction = async (action) => {
  if (!action) return;
  // Do this synchronously from pointerdown. Chrome only permits
  // sidePanel.open() while the content-script user gesture is live.
  const opened = await sendToExtension({
    type: "OPEN_LEAF_SIDEPANEL",
    open: true,
    payload: {
      mode: "result",
      title: "LeafReader",
      body: "Loading…",
      quote: selectedText,
      documentId,
      documentTitle,
      context: selectedContext,
    },
  });
  if (!opened?.ok) {
    toolbar.hidden = false;
    return;
  }
  handleAction(action).catch((error) =>
    display(
      "LeafReader error",
      `The selected action could not finish: ${error.message}`,
      selectedText,
    ),
  );
};
toolbar.addEventListener("pointerdown", (event) => {
  const action = event.target.dataset.action;
  if (!action) return;
  event.preventDefault();
  void startToolbarAction(action);
});
toolbar.addEventListener("click", (event) => event.preventDefault());
