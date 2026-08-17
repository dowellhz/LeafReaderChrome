(function exposeLeafSearch(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LeafSearch = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const normalize = (value) => clean(value).normalize('NFKC').toLocaleLowerCase();

  function terms(value) {
    const text = normalize(value); const output = [];
    for (const match of text.matchAll(/[a-z0-9][a-z0-9'-]*/g)) if (match[0].length > 1) output.push(match[0]);
    for (const match of text.matchAll(/[\u3400-\u9fff]+/g)) {
      const han = match[0];
      if (han.length === 1) output.push(han);
      for (let index = 0; index < han.length - 1; index += 1) output.push(han.slice(index, index + 2));
    }
    return [...new Set(output)];
  }

  function chunks(value, maxLength = 1300) {
    const paragraphs = String(value || '').split(/\n{2,}/).map(clean).filter(Boolean); const output = []; let current = '';
    const add = (text) => {
      let rest = clean(text);
      while (rest.length > maxLength) {
        const window = rest.slice(0, maxLength + 1); const cut = Math.max(...['。', '！', '？', '. ', '! ', '? ', '; ', '；', ' '].map((separator) => window.lastIndexOf(separator)).filter((index) => index >= maxLength * 0.45), maxLength - 1) + 1;
        output.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
      }
      if (rest) output.push(rest);
    };
    for (const paragraph of paragraphs) {
      if (paragraph.length > maxLength) { if (current) { output.push(current); current = ''; } add(paragraph); }
      else if (current && current.length + paragraph.length + 2 > maxLength) { output.push(current); current = paragraph; }
      else current += `${current ? '\n\n' : ''}${paragraph}`;
    }
    if (current) output.push(current);
    return output;
  }

  function build(value, maxLength = 1300) {
    const entries = chunks(value, maxLength).map((text, index) => {
      const tokens = terms(text); return { index, text, normalized:normalize(text), tokens:new Set(tokens), length:Math.max(1, tokens.length) };
    });
    const frequency = new Map(); entries.forEach((entry) => entry.tokens.forEach((token) => frequency.set(token, (frequency.get(token) || 0) + 1)));
    return { entries, frequency, averageLength:entries.reduce((sum, entry) => sum + entry.length, 0) / Math.max(1, entries.length) };
  }

  function search(index, question, limit = 6) {
    const query = terms(question); const phrase = normalize(question); const entries = index?.entries || [];
    if (!query.length || !entries.length) return [];
    const total = entries.length;
    return entries.map((entry) => {
      let score = 0; let matched = 0;
      query.forEach((token) => {
        if (!entry.tokens.has(token)) return;
        matched += 1; const idf = Math.log(1 + (total - (index.frequency.get(token) || 0) + .5) / ((index.frequency.get(token) || 0) + .5));
        score += idf * (1.2 / (1.2 + .75 * (entry.length / Math.max(1, index.averageLength))));
      });
      if (phrase.length > 3 && entry.normalized.includes(phrase)) score += 2.5;
      return { ...entry, score, coverage:matched / query.length, matched };
    }).filter((entry) => entry.matched).sort((left, right) => right.score - left.score || right.coverage - left.coverage || left.index - right.index).slice(0, limit);
  }

  return { build, chunks, search, terms };
});
