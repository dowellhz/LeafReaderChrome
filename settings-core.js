(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LeafSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function endpointIdentity(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      url.hash = '';
      url.hostname = url.hostname.toLocaleLowerCase();
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';
      return url.toString();
    } catch (_) {
      return raw.replace(/\/+$/, '').toLocaleLowerCase();
    }
  }

  function canReuseApiKey(current, restored) {
    return Boolean(current && restored
      && String(current.provider || '') === String(restored.provider || '')
      && endpointIdentity(current.endpoint)
      && endpointIdentity(current.endpoint) === endpointIdentity(restored.endpoint));
  }

  return { canReuseApiKey, endpointIdentity };
});
