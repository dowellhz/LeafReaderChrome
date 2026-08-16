function selectionChanged() {
  const current = getSelection();
  const text = cleanText(current?.toString());
  const range = current?.rangeCount ? current.getRangeAt(0) : null;
  if (
    !text ||
    !range ||
    !$("#article").contains(range.commonAncestorContainer)
  ) {
    $("#selectionToolbar").hidden = true;
    selected = null;
    return;
  }
  selected = {
    text,
    range: range.cloneRange(),
    context: cleanText(
      range.commonAncestorContainer.parentElement?.innerText,
    ).slice(0, 450),
    locator: null,
  };
  const rect = range.getBoundingClientRect();
  const bar = $("#selectionToolbar");
  bar.hidden = false;
  bar.style.left = `${Math.max(8, Math.min(innerWidth - 260, rect.left + rect.width / 2 - 110))}px`;
  bar.style.top = `${Math.max(8, rect.top - 46)}px`;
}
document.addEventListener("selectionchange", () =>
  requestAnimationFrame(selectionChanged),
);
function clearSelection() {
  getSelection()?.removeAllRanges();
  $("#selectionToolbar").hidden = true;
}
async function addHighlight() {
  if (!selected || !activeDocument) return;
  const record = {
    id: makeId("highlight"),
    documentId: activeDocument.id,
    documentTitle: activeDocument.title,
    quote: selected.text,
    context: selected.context,
    locator: selected.locator,
    kind: "highlight",
    createdAt: Date.now(),
  };
  annotations.push(record);
  wrapRange(selected.range, "leaf-highlight", record.id);
  await persistRecords();
  clearSelection();
}
async function addWord() {
  if (!selected || !activeDocument) return;
  const word = selected.text.slice(0, 160);
  const lemma = lemmaFor(word);
  const existing = vocabulary.find((item) => item.lemma === lemma);
  if (existing) {
    existing.occurrences = Number(existing.occurrences || 1) + 1;
    existing.lastSeenAt = Date.now();
    existing.updatedAt = Date.now();
    existing.documentIds = [
      ...new Set([
        ...(existing.documentIds || [existing.documentId].filter(Boolean)),
        activeDocument.id,
      ]),
    ];
    await persistRecords();
    wrapRange(selected.range, "leaf-word", existing.id);
    showToast(`Vocabulary updated: seen ${existing.occurrences} times.`);
    clearSelection();
    return;
  }
  vocabulary.push({
    id: makeId("word"),
    documentId: activeDocument.id,
    documentTitle: activeDocument.title,
    word,
    lemma,
    context: selected.context,
    contexts: [selected.context],
    documentIds: [activeDocument.id],
    locator: selected.locator,
    definition: "",
    occurrences: 1,
    status: "new",
    intervalDays: 0,
    dueAt: Date.now(),
    reviewCount: 0,
    correctCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  wrapRange(selected.range, "leaf-word", vocabulary.at(-1).id);
  await persistRecords();
  clearSelection();
  await lookupWord(word);
}
function openNote() {
  if (!selected) return;
  pendingNote = { ...selected, range: selected.range.cloneRange() };
  $("#noteQuote").textContent = pendingNote.text;
  $("#noteText").value = "";
  $("#noteDialog").showModal();
}
$("#noteDialog").addEventListener("close", async () => {
  const note = pendingNote;
  pendingNote = null;
  if ($("#noteDialog").returnValue !== "save" || !note) return;
  if (note.editing) {
    note.record.note = $("#noteText").value.trim();
    note.record.updatedAt = Date.now();
    await persistRecords();
    renderNotes();
    return;
  }
  if (!activeDocument) return;
  const record = {
    id: makeId("note"),
    documentId: activeDocument.id,
    documentTitle: activeDocument.title,
    quote: note.text,
    context: note.context,
    locator: note.locator,
    note: $("#noteText").value.trim(),
    kind: "note",
    favorite: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  annotations.push(record);
  wrapRange(note.range, "leaf-note", record.id);
  await persistRecords();
  clearSelection();
});
async function lookupWord(word) {
  openAssistant("Dictionary");
  try {
    const explanation = await askAI(
      "Explain this English word or short phrase for a Chinese learner. Use concise Markdown with: ## 发音, a contextual Chinese meaning, ## 常见用法 with natural examples, and ## 词性.",
      word,
      activeDocument?.text?.slice(0, 500) || "",
    );
    setAssistantResult(explanation);
    const item = vocabulary.find(
      (candidate) => candidate.lemma === lemmaFor(word),
    );
    if (item) {
      item.definition = explanation;
      await persistRecords();
    }
  } catch (_) {
    try {
      const response = await fetch(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
      );
      if (!response.ok) throw new Error();
      const [entry] = await response.json();
      const meanings = (entry.meanings || [])
        .slice(0, 3)
        .map(
          (meaning) =>
            `${meaning.partOfSpeech}: ${meaning.definitions?.[0]?.definition || ""}`,
        )
        .join("\n");
      const definition = `AI 未配置或不可用，以下为英文词典释义。\n${entry.word}${entry.phonetic ? `  ${entry.phonetic}` : ""}\n${meanings}`;
      setAssistantResult(definition, false);
      const item = vocabulary.find(
        (candidate) => candidate.lemma === lemmaFor(word),
      );
      if (item) {
        item.definition = definition;
        item.updatedAt = Date.now();
        await persistRecords();
      }
    } catch (_) {
      setAssistantResult(
        "AI 未配置或不可用，且没有找到在线英文词典条目。",
        false,
      );
    }
  }
}
function openAssistant(title) {
  $("#assistantTitle").textContent = title;
  setAssistantResult("Thinking…", false);
  $("#assistantPanel").hidden = false;
}
async function askAI(instruction, text, context = "") {
  const result = await chrome.runtime.sendMessage({
    type: "AI_REQUEST",
    instruction,
    text,
    context,
  });
  if (!result?.ok)
    throw new Error(
      result?.error || "Extension background returned no response.",
    );
  return result.content;
}
function documentChunks(text, size = 1500) {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map(cleanText)
    .filter(Boolean);
  const units = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= size) units.push(paragraph);
    else {
      let rest = paragraph;
      while (rest.length > size) {
        const window = rest.slice(0, size + 1);
        const boundary = Math.max(
          window.lastIndexOf("。"),
          window.lastIndexOf("！"),
          window.lastIndexOf("？"),
          window.lastIndexOf(". "),
          window.lastIndexOf("! "),
          window.lastIndexOf("? "),
          window.lastIndexOf(" "),
        );
        const cut = boundary > size * 0.45 ? boundary + 1 : size;
        units.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) units.push(rest);
    }
  }
  const chunks = [];
  let current = "";
  for (const paragraph of units) {
    if (current && current.length + paragraph.length + 2 > size) {
      chunks.push(current);
      current = "";
    }
    current += `${current ? "\n\n" : ""}${paragraph}`;
  }
  if (current) chunks.push(current);
  return chunks;
}
function retrievalContext(question) {
  const chunks = documentChunks(
    activeDocument?.text || $("#article").innerText,
  );
  const tokens =
    cleanText(question)
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) || [];
  const scored = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: tokens.reduce(
        (score, token) =>
          score +
          (
            chunk
              .toLocaleLowerCase()
              .match(
                new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
              ) || []
          ).length,
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = scored.some((item) => item.score)
    ? scored.slice(0, 5)
    : scored.slice(0, 6);
  activeSources = selected.map((item) => item.chunk);
  return selected
    .map((item, source) => `[S${source + 1}] ${item.chunk}`)
    .join("\n\n");
}
async function askAboutDocument(question) {
  const sources = retrievalContext(question);
  return askAI(
    `${question}\n\nAnswer only from the supplied source excerpts. Cite every substantive claim as [S1], [S2], etc. If the sources do not support an answer, say so.`,
    "",
    sources,
  );
}
async function aiAction(action) {
  if (!selected) return;
  const title = action === "translate" ? "Translation" : "AI explanation";
  openAssistant(title);
  try {
    setAssistantResult(
      await askAI(
        action === "translate"
          ? "Translate naturally. Output the translation first, then only brief notes if needed."
          : "Explain this word, phrase, or passage: its meaning in context, important usage, and any grammar worth noticing.",
        selected.text,
        selected.context,
      ),
    );
  } catch (error) {
    setAssistantResult(
      `Could not reach the AI provider: ${error.message}`,
      false,
    );
  }
  clearSelection();
}
