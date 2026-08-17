(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LeafTranslation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeSelectionText(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function prepareParagraphTranslation(value) {
    const text = normalizeSelectionText(value);
    const paragraphs = text.split(/\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
    return {
      count:paragraphs.length,
      text:paragraphs.length > 1
        ? paragraphs.map((paragraph, index) => `[[P${index + 1}]] ${paragraph}`).join('\n\n')
        : text
    };
  }

  function restoreParagraphTranslation(value, expectedCount) {
    const text = normalizeSelectionText(value);
    if (expectedCount <= 1) return text;
    const marker = /\[\[P(\d+)\]\]/g;
    const matches = [...text.matchAll(marker)];
    const paragraphs = new Map();
    matches.forEach((match, index) => {
      const number = Number(match[1]);
      const start = match.index + match[0].length;
      const end = matches[index + 1]?.index ?? text.length;
      paragraphs.set(number, text.slice(start, end).trim());
    });
    if (Array.from({ length:expectedCount }, (_, index) => paragraphs.has(index + 1)).every(Boolean)) {
      return Array.from({ length:expectedCount }, (_, index) => paragraphs.get(index + 1)).join('\n\n');
    }
    return text.replace(marker, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  return { normalizeSelectionText, prepareParagraphTranslation, restoreParagraphTranslation };
});
