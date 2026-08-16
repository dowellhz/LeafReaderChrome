(() => {
  const esc = (value) =>
    String(value || "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  const inline = (value) =>
    esc(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
      .replace(/(?<!_)_([^_]+)_(?!_)/g, "<em>$1</em>");

  function markdown(value) {
    const lines = String(value || "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const output = [];
    let paragraph = [];
    let list = null;
    const cells = (line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
    const separator = (line) =>
      line.includes("|") &&
      cells(line).length > 1 &&
      cells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
    const flushParagraph = () => {
      if (paragraph.length)
        output.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (list)
        output.push(
          `<${list.type}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.type}>`,
        );
      list = null;
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      const quote = line.match(/^>\s?(.+)$/);
      if (line.includes("|") && separator(lines[index + 1] || "")) {
        flushParagraph();
        flushList();
        const headers = cells(line);
        const rows = [];
        index += 2;
        while (
          index < lines.length &&
          lines[index].includes("|") &&
          lines[index].trim()
        )
          rows.push(cells(lines[index++]));
        index -= 1;
        output.push(
          `<div class="table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cell) => `<td>${inline(row[cell] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
        );
      } else if (heading) {
        flushParagraph();
        flushList();
        output.push(
          `<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`,
        );
      } else if (bullet || ordered) {
        flushParagraph();
        const type = ordered ? "ol" : "ul";
        if (!list || list.type !== type) {
          flushList();
          list = { type, items: [] };
        }
        list.items.push((bullet || ordered)[1]);
      } else if (quote) {
        flushParagraph();
        flushList();
        output.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      } else if (!line.trim()) {
        flushParagraph();
        flushList();
      } else {
        flushList();
        paragraph.push(line);
      }
    }
    flushParagraph();
    flushList();
    return output.join("") || "<p></p>";
  }

  window.LeafReaderMarkdown = { esc, markdown };
})();
