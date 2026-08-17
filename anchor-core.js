(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LeafAnchor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function findAnchorPosition(text, anchor) {
    const exact = cleanText(anchor?.exact);
    if (!exact) return -1;
    const haystack = String(text || '');
    const folded = haystack.toLocaleLowerCase();
    const needle = exact.toLocaleLowerCase();
    const candidates = [];
    let position = folded.indexOf(needle);
    while (position >= 0) {
      candidates.push(position);
      position = folded.indexOf(needle, position + Math.max(1, needle.length));
    }
    if (!candidates.length) return -1;
    const expected = Number.isFinite(Number(anchor?.position)) ? Number(anchor.position) : 0;
    const score = (candidate) => {
      const prefix = String(anchor?.prefix || '');
      const suffix = String(anchor?.suffix || '');
      return (prefix && haystack.slice(Math.max(0, candidate - prefix.length), candidate) === prefix ? 10000 : 0)
        + (suffix && haystack.slice(candidate + exact.length, candidate + exact.length + suffix.length) === suffix ? 10000 : 0)
        - Math.abs(candidate - expected);
    };
    return candidates.reduce((best, candidate) => score(candidate) > score(best) ? candidate : best, candidates[0]);
  }

  function buildTextIndex(root, excludedSelector = '') {
    if (!root) return { text: '', segments: [] };
    const documentRef = root.ownerDocument || root;
    const walker = documentRef.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (excludedSelector && node.parentElement?.closest(excludedSelector)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const parts = [];
    const segments = [];
    let normalizedOffset = 0;
    let previousWasWhitespace = false;
    let node;
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue;
      const runs = raw.matchAll(/\s+|\S+/gu);
      for (const match of runs) {
        const rawStart = match.index;
        const rawEnd = rawStart + match[0].length;
        const whitespace = /^\s+$/u.test(match[0]);
        if (whitespace && previousWasWhitespace) continue;
        const normalized = whitespace ? ' ' : match[0];
        const normalizedStart = normalizedOffset;
        normalizedOffset += normalized.length;
        parts.push(normalized);
        segments.push({ node, rawStart, rawEnd, normalizedStart, normalizedEnd: normalizedOffset, whitespace });
        previousWasWhitespace = whitespace;
      }
    }
    return { text: parts.join(''), segments };
  }

  function normalizedPosition(index, node, offset, end = false) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return -1;
    const nodeSegments = index.segments.filter((segment) => segment.node === node);
    for (const segment of nodeSegments) {
      if (offset < segment.rawStart) return segment.normalizedStart;
      if (offset <= segment.rawEnd) {
        if (segment.whitespace) return end && offset > segment.rawStart ? segment.normalizedEnd : segment.normalizedStart;
        return segment.normalizedStart + Math.max(0, Math.min(offset - segment.rawStart, segment.normalizedEnd - segment.normalizedStart));
      }
    }
    return nodeSegments.at(-1)?.normalizedEnd ?? -1;
  }

  function domPoint(index, position, end = false) {
    if (!index.segments.length) return null;
    const bounded = Math.max(0, Math.min(Number(position) || 0, index.text.length));
    for (const segment of index.segments) {
      const inside = end
        ? bounded > segment.normalizedStart && bounded <= segment.normalizedEnd
        : bounded >= segment.normalizedStart && bounded < segment.normalizedEnd;
      if (!inside) continue;
      if (segment.whitespace) return { node: segment.node, offset: end ? segment.rawEnd : segment.rawStart };
      return { node: segment.node, offset: segment.rawStart + bounded - segment.normalizedStart };
    }
    const edge = end ? index.segments.at(-1) : index.segments[0];
    return { node: edge.node, offset: end ? edge.rawEnd : edge.rawStart };
  }

  function createAnchor(range, index) {
    const exact = cleanText(range?.toString());
    if (!exact) return null;
    let start = normalizedPosition(index, range.startContainer, range.startOffset);
    let end = normalizedPosition(index, range.endContainer, range.endOffset, true);
    if (start < 0 || end <= start || index.text.slice(start, end) !== exact) {
      start = index.text.toLocaleLowerCase().indexOf(exact.toLocaleLowerCase());
      end = start < 0 ? -1 : start + exact.length;
    }
    if (start < 0) return { exact, prefix: '', suffix: '', position: -1 };
    return {
      exact,
      prefix: index.text.slice(Math.max(0, start - 80), start),
      suffix: index.text.slice(end, end + 80),
      position: start
    };
  }

  function rangeForAnchor(anchor, index, documentRef) {
    const exact = cleanText(anchor?.exact);
    const start = findAnchorPosition(index.text, { ...anchor, exact });
    if (start < 0) return null;
    const first = domPoint(index, start);
    const last = domPoint(index, start + exact.length, true);
    if (!first || !last) return null;
    const range = documentRef.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    return range;
  }

  return { buildTextIndex, cleanText, createAnchor, findAnchorPosition, rangeForAnchor };
});
