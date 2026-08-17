(function exposeLeafSidePanelHistory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LeafSidePanelHistory = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const entryTitle = (kind, presentation) => ({
    translation:'Translation',
    dictionary:'单词释义',
    analysis:'难句分析',
    explanation:'讲解',
    note:'Note',
    highlight:'Highlight'
  }[kind] || (presentation === 'dictionary' ? '单词释义' : 'LeafReader AI'));

  function threadFromHistory(documentId, documentTitle, annotations = [], aiConversations = {}) {
    if (!documentId) return null;
    const entries = [];
    const seen = new Set();
    const addEntry = (conversationId, record = {}, conversation = {}, readOnly = false) => {
      if (!conversationId || seen.has(conversationId)) return;
      seen.add(conversationId);
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const latestAnswer = [...messages].reverse().find((message) => message?.role === 'assistant')?.content || '';
      const savedLabel = ({ highlight:'Highlighted on this page.', note:'Saved note.', word:'Saved to vocabulary.' })[record.kind] || 'Saved webpage marker.';
      entries.push({
        conversationId,
        title:entryTitle(record.kind, conversation.presentation || record.presentation),
        body:latestAnswer || record.note || record.definition || savedLabel,
        quote:conversation.quote || record.quote || record.word || '',
        context:conversation.context || record.context || '',
        documentId,
        documentTitle:conversation.documentTitle || record.documentTitle || documentTitle,
        presentation:conversation.presentation || record.presentation || (record.kind === 'dictionary' ? 'dictionary' : 'chat'),
        readOnly,
        updatedAt:Number(conversation.updatedAt || record.updatedAt || record.createdAt || 0)
      });
    };
    for (const record of Array.isArray(annotations) ? annotations : []) {
      if (record?.documentId !== documentId) continue;
      const conversationId = record.conversationId || `record:${record.id}`;
      addEntry(conversationId, record, aiConversations[`conversation:${record.conversationId}`], !record.conversationId);
    }
    for (const [key, conversation] of Object.entries(aiConversations || {})) {
      if (conversation?.documentId !== documentId) continue;
      addEntry(key.replace(/^conversation:/, ''), {}, conversation, false);
    }
    entries.sort((left, right) => left.updatedAt - right.updatedAt);
    if (!entries.length) return null;
    return { documentId, documentTitle:entries.at(-1).documentTitle || documentTitle, entries, scrollTop:0, updatedAt:entries.at(-1).updatedAt };
  }

  return { threadFromHistory };
});
