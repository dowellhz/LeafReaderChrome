(function exposeLeafDictionary(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LeafDictionary = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  let entries;
  const normalize = (value) => String(value || '').toLocaleLowerCase().trim().replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, '');
  const variants = (value) => {
    const word = normalize(value); const values = [word];
    if (word.endsWith('ies') && word.length > 4) values.push(`${word.slice(0, -3)}y`);
    if (word.endsWith('ing') && word.length > 5) values.push(word.slice(0, -3).replace(/([b-df-hj-np-tv-z])\1$/, '$1'));
    if (word.endsWith('ied') && word.length > 4) values.push(`${word.slice(0, -3)}y`);
    else if (word.endsWith('ed') && word.length > 4) values.push(word.slice(0, -2).replace(/([b-df-hj-np-tv-z])\1$/, '$1'));
    if (word.endsWith('es') && word.length > 4) values.push(word.slice(0, -2));
    if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) values.push(word.slice(0, -1));
    return [...new Set(values.filter(Boolean))];
  };
  async function load() {
    if (entries) return entries;
    const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('offline-dictionary-data.json') : 'offline-dictionary-data.json';
    const rows = await fetch(url).then((response) => { if (!response.ok) throw new Error('Offline dictionary data is unavailable.'); return response.json(); });
    entries = new Map(rows.map((entry) => [normalize(entry.word), entry])); return entries;
  }
  async function lookup(value) {
    const dictionary = await load();
    return variants(value).map((word) => dictionary.get(word)).find(Boolean) || null;
  }
  function markdown(entry) {
    if (!entry) return '';
    const tags = [entry.pos, entry.oxford ? 'Oxford 3000' : '', entry.tag].filter(Boolean).join(' · ');
    const definitions = String(entry.translation || entry.definition || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 6);
    return [`## ${entry.word}${entry.phonetic ? ` · /${entry.phonetic.replace(/^\/+|\/+$/g, '')}/` : ''}`, tags ? `\n${tags}` : '', '\n## 释义', ...definitions.map((line) => `- ${line}`)].filter(Boolean).join('\n');
  }
  return { load, lookup, markdown, normalize, variants };
});
