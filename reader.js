function bind() {
  $$(".nav[data-view]").forEach(
    (button) =>
      (button.onclick = () => {
        showView(button.dataset.view);
        refreshLibrary();
      }),
  );
  $("#exportNotesMarkdown").onclick = () =>
    downloadExport("leafreader-notes.md", notesMarkdown(), "text/markdown");
  $("#exportNotesJson").onclick = () =>
    downloadExport(
      "leafreader-notes.json",
      JSON.stringify(annotations, null, 2),
    );
  $("#exportWordsJson").onclick = () =>
    downloadExport(
      "leafreader-vocabulary.json",
      JSON.stringify(vocabulary, null, 2),
    );
  $("#reviewDue").onclick = () => {
    const word = [...vocabulary]
      .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0))
      .find((item) => (item.dueAt || 0) <= Date.now());
    if (!word) {
      showToast("No vocabulary is due for review.");
      return;
    }
    document
      .querySelector(`[data-review-word="${CSS.escape(word.id)}"]`)
      ?.closest(".record")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  $("#openPage").onclick =
    $("#openPage2").onclick =
    $("#emptyOpen").onclick =
      () => chrome.runtime.sendMessage({ type: "OPEN_ACTIVE_PAGE" });
  $("#settings").onclick = () => chrome.runtime.openOptionsPage();
  $("#librarySearch").oninput = () => dbAll().then(renderDocuments);
  $("#sortDocuments").onchange = () => dbAll().then(renderDocuments);
  $("#backLibrary").onclick = () => {
    stopSpeaking();
    void flushProgress();
    showView("library");
    refreshLibrary();
  };
  $("#searchToggle").onclick = () => {
    $("#searchBar").hidden = !$("#searchBar").hidden;
    if (!$("#searchBar").hidden) $("#inDocumentSearch").focus();
  };
  $("#closeSearch").onclick = () => {
    $("#searchBar").hidden = true;
    $("#inDocumentSearch").value = "";
    highlightSearch();
  };
  $("#inDocumentSearch").oninput = highlightSearch;
  $("#nextMatch").onclick = () => moveMatch(1);
  $("#previousMatch").onclick = () => moveMatch(-1);
  $("#readerSettings").onclick = () =>
    ($("#readingSettings").hidden = !$("#readingSettings").hidden);
  [
    ["fontSize", "--text-size", "leaf-font-size", "px"],
    ["textWidth", "--text-width", "leaf-text-width", "px"],
    ["lineHeight", "--leading", "leaf-leading", ""],
  ].forEach(
    ([id, prop, key, unit]) =>
      ($("#" + id).oninput = (event) => {
        $("#article").style.setProperty(prop, event.target.value + unit);
        localStorage.setItem(key, event.target.value);
      }),
  );
  $("#themeToggle").onclick = () => document.body.classList.toggle("dark");
  $("#ttsToggle").onclick = toggleSpeaking;
  $("#ttsVoice").onchange = (event) => {
    localStorage.setItem("leaf-tts-voice", event.target.value);
    if (speaking) {
      const documentQueue = ttsForDocument;
      const resumeAt = ttsIndex;
      const remaining = ttsQueue.slice(ttsIndex);
      stopSpeaking(false);
      ttsForDocument = documentQueue;
      ttsQueue = documentQueue ? articleSentenceQueue() : remaining;
      ttsIndex = documentQueue ? resumeAt : 0;
      speaking = true;
      $("#ttsToggle").classList.add("active");
      speakNext();
    }
  };
  $("#ttsRate").value = localStorage.getItem("leaf-tts-rate") || 1;
  $("#ttsRate").oninput = (event) => {
    localStorage.setItem("leaf-tts-rate", event.target.value);
  };
  $("#aiSummary").onclick = async () => {
    if (!activeDocument) return;
    openAssistant("Reading summary");
    try {
      setAssistantResult(
        await askAboutDocument(
          "Summarize this reading in 3–5 concise key points, then list important people, events, or ideas and one reading note.",
        ),
      );
    } catch (error) {
      setAssistantResult(
        `Could not reach the AI provider: ${error.message}`,
        false,
      );
    }
  };
  $("#selectionToolbar").onmousedown = (event) => event.preventDefault();
  $("#selectionToolbar").onclick = (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (!action) return;
    if (action === "highlight") addHighlight();
    if (action === "note") openNote();
    if (action === "word") addWord();
    if (action === "translate" || action === "explain") aiAction(action);
    if (action === "speak") speak();
  };
  $("#closeAssistant").onclick = () => ($("#assistantPanel").hidden = true);
  $("#followUpForm").onsubmit = async (event) => {
    event.preventDefault();
    const question = $("#followUp").value.trim();
    if (!question) return;
    openAssistant("LeafReader AI");
    try {
      setAssistantResult(await askAboutDocument(question));
    } catch (error) {
      setAssistantResult(
        `Could not reach the AI provider: ${error.message}`,
        false,
      );
    }
    $("#followUp").value = "";
  };
  $("#article").onclick = (event) => {
    const mark = event.target.closest(".leaf-note,.leaf-word");
    if (!mark) return;
    const item =
      annotations.find((x) => x.id === mark.dataset.annotationId) ||
      vocabulary.find((x) => x.id === mark.dataset.annotationId);
    if (item?.note) showToast(item.note);
    else if (item?.definition) {
      openAssistant("Dictionary");
      setAssistantResult(item.definition);
      $("#assistantPanel").hidden = false;
    }
  };
}
bind();
populateVoices();
speechSynthesis.onvoiceschanged = populateVoices;
loadState().catch((error) =>
  showToast(`LeafReader could not open its library: ${error.message}`),
);
