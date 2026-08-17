(function exposeLeafTts(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LeafTts = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function preferredLanguage(text = '', fallback = 'en-US') {
    const value = String(text || '');
    const kana = (value.match(/[\u3040-\u30ff]/g) || []).length;
    const hangul = (value.match(/[\uac00-\ud7af]/g) || []).length;
    const han = (value.match(/[\u3400-\u9fff]/g) || []).length;
    const latin = (value.match(/[A-Za-z]/g) || []).length;
    if (kana) return 'ja-JP';
    if (hangul) return 'ko-KR';
    if (han && (!latin || han >= latin * 0.25)) return 'zh-CN';
    if (latin) return 'en-US';
    return fallback;
  }

  const languageKey = (language) => String(language || 'en').toLowerCase().split('-')[0];

  function selectVoice(voices, language, configuredVoiceUri = '', localOnly = true) {
    const key = languageKey(language);
    const compatible = (Array.isArray(voices) ? voices : []).filter((voice) => languageKey(voice?.lang) === key);
    const candidates = localOnly ? compatible.filter((voice) => voice.localService) : compatible;
    const configured = candidates.find((voice) => voice.voiceURI === configuredVoiceUri);
    if (configured) return configured;
    return [...candidates].sort((left, right) => {
      const score = (voice) => (String(voice.lang).toLowerCase() === String(language).toLowerCase() ? 4 : 0) + (voice.localService ? 2 : 0) + (voice.default ? 1 : 0);
      return score(right) - score(left);
    })[0] || null;
  }

  function chunkText(text, maxLength = 280) {
    const value = cleanText(text); if (!value) return [];
    const units = [];
    const addUnit = (rawStart, rawEnd) => {
      let start = rawStart; let end = rawEnd;
      while (start < end && /\s/.test(value[start])) start += 1;
      while (end > start && /\s/.test(value[end - 1])) end -= 1;
      while (end - start > maxLength) {
        const window = value.slice(start, start + maxLength + 1);
        const positions = ['。', '！', '？', '; ', '；', ', ', '，', ': ', '：', ' '].map((separator) => window.lastIndexOf(separator)).filter((position) => position >= maxLength * 0.55);
        const cut = Math.min(maxLength, positions.length ? Math.max(...positions) + 1 : maxLength);
        addUnit(start, start + cut); start += cut;
        while (start < end && /\s/.test(value[start])) start += 1;
      }
      if (end > start) units.push({ start, end, text:value.slice(start, end), language:preferredLanguage(value.slice(start, end)) });
    };
    const addSentence = (start, end) => {
      const sentence = value.slice(start, end); const clauses = []; const pattern = /[^,，;；:：]+(?:[,，;；:：]+|$)/g; let match;
      while ((match = pattern.exec(sentence))) clauses.push({ start:start + match.index, end:start + match.index + match[0].length, language:preferredLanguage(match[0]) });
      if (clauses.length > 1 && new Set(clauses.map((clause) => clause.language)).size > 1) clauses.forEach((clause) => addUnit(clause.start, clause.end));
      else addUnit(start, end);
    };
    if (Intl.Segmenter) {
      for (const entry of new Intl.Segmenter(preferredLanguage(value), { granularity:'sentence' }).segment(value)) addSentence(entry.index, entry.index + entry.segment.length);
    } else {
      const pattern = /[^.!?。！？]+[.!?。！？]*|.+$/g; let match;
      while ((match = pattern.exec(value))) addSentence(match.index, match.index + match[0].length);
    }
    const chunks = [];
    for (const unit of units) {
      const current = chunks.at(-1);
      if (current && current.language === unit.language && unit.end - current.start <= maxLength) { current.end = unit.end; current.text = value.slice(current.start, current.end); }
      else chunks.push({ ...unit });
    }
    return chunks;
  }

  function speechText(text, language = preferredLanguage(text)) {
    return String(text || '')
      .replace(/https?:\/\/\S+/gi, language === 'zh-CN' ? '链接' : 'link')
      .replace(/[`*_#~]{2,}/g, ' ')
      .replace(/([!?。！？,，;；])\1+/g, '$1')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([!?。！？,，;；])/g, '$1')
      .trim();
  }

  function createPlaybackState() {
    let generation = 0; let remaining = 0; let paused = false;
    return {
      get generation() { return generation; },
      get remaining() { return remaining; },
      get paused() { return paused; },
      begin(count) { generation += 1; remaining = Math.max(0, Number(count) || 0); paused = false; return generation; },
      cancel() { generation += 1; remaining = 0; paused = false; return generation; },
      isCurrent(token) { return token === generation; },
      complete(token) { if (token !== generation) return { accepted:false, done:false, remaining }; remaining = Math.max(0, remaining - 1); return { accepted:true, done:remaining === 0, remaining }; },
      fail(token) { if (token !== generation) return 0; generation += 1; remaining = 0; paused = false; return generation; },
      pause() { if (remaining) paused = true; return paused; },
      resume() { paused = false; return paused; }
    };
  }

  return { chunkText, cleanText, createPlaybackState, languageKey, preferredLanguage, selectVoice, speechText };
});
