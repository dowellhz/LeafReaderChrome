async function refreshLibrary() {
  const docs = await dbAll();
  $("#libraryCount").textContent =
    `${docs.length} item${docs.length === 1 ? "" : "s"} in library`;
  renderDocuments(docs);
  renderNotes();
  renderWords();
}
function renderDocuments(docs) {
  const query = $("#librarySearch").value.toLowerCase();
  const order = $("#sortDocuments").value;
  const sorted = docs
    .filter((doc) => `${doc.title} ${doc.text}`.toLowerCase().includes(query))
    .sort((a, b) =>
      order === "title"
        ? a.title.localeCompare(b.title)
        : order === "progress"
          ? (b.progress || 0) - (a.progress || 0)
          : (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0),
    );
  $("#documentGrid").innerHTML = sorted
    .map(
      (doc) =>
        `<button class="book-card" data-document-id="${escapeHtml(doc.id)}"><div class="book-cover">${escapeHtml(doc.title).slice(0, 70)}</div><div class="card-body"><strong>${escapeHtml(doc.title)}</strong><small>${escapeHtml(doc.byline || doc.type || "Web article")} · ${relativeDate(doc.lastOpenedAt || doc.createdAt)}</small><div class="card-progress"><i style="width:${Math.round((doc.progress || 0) * 100)}%"></i></div></div></button>`,
    )
    .join("");
  $("#emptyLibrary").hidden = sorted.length > 0;
  $("#documentGrid").hidden = !sorted.length;
  $$("#documentGrid [data-document-id]").forEach(
    (button) =>
      (button.onclick = () => openDocument(button.dataset.documentId)),
  );
}
function renderNotes() {
  const latest = [...annotations].sort((a, b) => b.createdAt - a.createdAt);
  const card = (note) =>
    [
      '<article class="record">',
      '<div class="record-actions">',
      `<button title="Delete marker" data-delete-note="${note.id}">×</button>`,
      `<button title="${note.favorite ? "Remove favorite" : "Favorite"}" data-favorite-note="${note.id}">${note.favorite ? "★" : "☆"}</button>`,
      `<button title="Edit note" data-edit-note="${note.id}">✎</button>`,
      note.documentId?.startsWith("web:")
        ? `<button title="Open webpage" data-open-note="${note.id}">↗</button>`
        : "",
      "</div>",
      `<blockquote>${escapeHtml(note.quote)}</blockquote>`,
      note.note ? `<p>${escapeHtml(note.note)}</p>` : "",
      `<small>${annotationLabel(note.kind)} · ${escapeHtml(note.documentTitle || "Reading")} · ${relativeDate(note.createdAt)}</small>`,
      "</article>",
    ].join("");
  $("#notesList").innerHTML = latest.length
    ? latest.map(card).join("")
    : `<div class="empty"><div class="leaf-illustration">✎</div><h2>No markers yet</h2><p>Select text while reading, then choose a reading action.</p></div>`;
  $$("[data-delete-note]").forEach(
    (button) =>
      (button.onclick = async () => {
        annotations = annotations.filter(
          (note) => note.id !== button.dataset.deleteNote,
        );
        await persistRecords();
        renderNotes();
      }),
  );
  $$("[data-favorite-note]").forEach(
    (button) =>
      (button.onclick = async () => {
        const note = annotations.find(
          (item) => item.id === button.dataset.favoriteNote,
        );
        if (!note) return;
        note.favorite = !note.favorite;
        note.updatedAt = Date.now();
        await persistRecords();
        renderNotes();
      }),
  );
  $$("[data-edit-note]").forEach(
    (button) =>
      (button.onclick = () => {
        const note = annotations.find(
          (item) => item.id === button.dataset.editNote,
        );
        if (!note) return;
        pendingNote = { record: note, editing: true };
        $("#noteQuote").textContent = note.quote;
        $("#noteText").value = note.note || "";
        $("#noteDialog").showModal();
      }),
  );
  $$("[data-open-note]").forEach(
    (button) =>
      (button.onclick = () =>
        chrome.runtime.sendMessage({
          type: "OPEN_DOCUMENT_SOURCE",
          documentId: annotations.find(
            (item) => item.id === button.dataset.openNote,
          )?.documentId,
        })),
  );
}
function renderWords() {
  const latest = [...vocabulary].sort(
    (a, b) =>
      (a.dueAt || Infinity) - (b.dueAt || Infinity) ||
      b.createdAt - a.createdAt,
  );
  const due = latest.filter((word) => (word.dueAt || 0) <= Date.now()).length;
  $("#reviewDue").textContent = due ? `Review ${due}` : "Review due";
  const card = (word) =>
    [
      '<article class="record word-record">',
      '<div class="record-actions">',
      `<button title="Remove word" data-delete-word="${word.id}">×</button>`,
      `<button title="Look up definition" data-lookup-word="${word.id}">⌕</button>`,
      `<button title="Mark known" data-known-word="${word.id}">✓</button>`,
      "</div>",
      `<blockquote>${escapeHtml(word.word)}</blockquote>`,
      word.definition
        ? `<p class="word-definition">${escapeHtml(word.definition)}</p>`
        : '<p class="muted">No definition yet — use the search button to look it up.</p>',
      '<div class="review-actions">',
      `<button data-review-word="${word.id}" data-quality="again">Again</button>`,
      `<button data-review-word="${word.id}" data-quality="good">Remember</button>`,
      "</div>",
      `<small>${escapeHtml(word.status || "new")} · seen ${word.occurrences || 1}× · reviewed ${word.reviewCount || 0}×${word.dueAt ? ` · ${word.dueAt <= Date.now() ? "due now" : `next ${new Date(word.dueAt).toLocaleDateString()}`}` : ""}</small>`,
      "</article>",
    ].join("");
  $("#wordsList").innerHTML = latest.length
    ? latest.map(card).join("")
    : `<div class="empty"><div class="leaf-illustration">◎</div><h2>Your vocabulary will grow here</h2><p>Select a word or phrase and save it while reading.</p></div>`;
  $$("[data-delete-word]").forEach(
    (button) =>
      (button.onclick = async () => {
        vocabulary = vocabulary.filter(
          (word) => word.id !== button.dataset.deleteWord,
        );
        await persistRecords();
        renderWords();
      }),
  );
  $$("[data-known-word]").forEach(
    (button) =>
      (button.onclick = async () => {
        const word = vocabulary.find(
          (item) => item.id === button.dataset.knownWord,
        );
        if (!word) return;
        word.status = "known";
        word.dueAt = Date.now() + 30 * 86400000;
        word.intervalDays = 30;
        word.updatedAt = Date.now();
        await persistRecords();
        renderWords();
      }),
  );
  $$("[data-lookup-word]").forEach(
    (button) =>
      (button.onclick = () => {
        const word = vocabulary.find(
          (item) => item.id === button.dataset.lookupWord,
        );
        if (word) lookupWord(word.word);
      }),
  );
  $$("[data-review-word]").forEach(
    (button) =>
      (button.onclick = async () => {
        const word = vocabulary.find(
          (item) => item.id === button.dataset.reviewWord,
        );
        if (!word) return;
        const correct = button.dataset.quality === "good";
        word.reviewCount = Number(word.reviewCount || 0) + 1;
        word.correctCount = Number(word.correctCount || 0) + (correct ? 1 : 0);
        word.intervalDays = correct
          ? Math.min(
              90,
              Math.max(1, Math.round((word.intervalDays || 0) * 2.4) || 1),
            )
          : 1;
        word.status = correct ? "learning" : "new";
        word.dueAt = Date.now() + word.intervalDays * 86400000;
        word.updatedAt = Date.now();
        await persistRecords();
        renderWords();
      }),
  );
}

function downloadExport(filename, content, type = "application/json") {
  const url = URL.createObjectURL(
    new Blob([content], { type: `${type};charset=utf-8` }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function notesMarkdown() {
  return [...annotations]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(
      (note) =>
        `## ${note.documentTitle || "Reading"}\n\n> ${note.quote || ""}\n\n${note.note || ""}\n\n_${new Date(note.createdAt).toLocaleString()}${note.favorite ? " · ★ Favorite" : ""}_\n`,
    )
    .join("\n");
}
