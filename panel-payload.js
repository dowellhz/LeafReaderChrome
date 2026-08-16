(() => {
  const isThreadPayload = (payload) =>
    Boolean(
      payload?.documentId &&
      payload?.conversationId &&
      !payload.conversationCleared,
    );

  window.LeafReaderPanelPayload = { isThreadPayload };
})();
