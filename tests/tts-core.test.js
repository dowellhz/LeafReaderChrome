const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkText, createPlaybackState, preferredLanguage, selectVoice, speechText } = require('../tts-core.js');

test('detects the dominant language without switching for a short foreign term', () => {
  assert.equal(preferredLanguage('This English sentence contains 中文 terms.'), 'en-US');
  assert.equal(preferredLanguage('这是中文内容，with an English product name.'), 'zh-CN');
  assert.equal(preferredLanguage('こんにちは世界'), 'ja-JP');
  assert.equal(preferredLanguage('안녕하세요 LeafReader'), 'ko-KR');
});

test('splits mixed-language clauses and bounds long chunks', () => {
  const mixed = chunkText('这是中文内容，Chrome TTS reads this part in English.');
  assert.deepEqual(mixed.map((chunk) => chunk.language), ['zh-CN', 'en-US']);
  const long = chunkText('A'.repeat(701));
  assert.deepEqual(long.map((chunk) => chunk.text.length), [280, 280, 141]);
  assert.ok(long.every((chunk) => chunk.text.length <= 280));
});

test('selects configured voices and enforces local-only mode', () => {
  const voices = [
    { voiceURI:'remote-en', lang:'en-US', localService:false, default:true },
    { voiceURI:'local-gb', lang:'en-GB', localService:true, default:false },
    { voiceURI:'local-en', lang:'en-US', localService:true, default:false }
  ];
  assert.equal(selectVoice(voices, 'en-US', '', true).voiceURI, 'local-en');
  assert.equal(selectVoice(voices, 'en-US', 'local-gb', true).voiceURI, 'local-gb');
  assert.equal(selectVoice([{ voiceURI:'remote', lang:'zh-CN', localService:false }], 'zh-CN', '', true), null);
});

test('normalizes text that sounds noisy when synthesized', () => {
  assert.equal(speechText('Visit https://example.com/a **now**!!!', 'en-US'), 'Visit link now!');
  assert.equal(speechText('打开 https://example.com ，，，', 'zh-CN'), '打开 链接，');
});

test('ignores stale playback callbacks after cancel or replacement', () => {
  const state = createPlaybackState();
  const first = state.begin(2); assert.equal(state.complete(first).remaining, 1);
  const canceled = state.cancel(); assert.equal(state.remaining, 0); assert.equal(state.complete(first).accepted, false); assert.equal(state.isCurrent(canceled), true);
  const second = state.begin(1); state.pause(); assert.equal(state.paused, true); state.resume(); assert.equal(state.paused, false); assert.equal(state.complete(second).done, true);
  const third = state.begin(3); const failed = state.fail(third); assert.ok(failed > third); assert.equal(state.remaining, 0); assert.equal(state.complete(third).accepted, false);
});
