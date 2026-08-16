(() => {
  const maxBackupBytes = 50 * 1024 * 1024;

  const asObject = (value, label) => {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error(`The backup ${label} must be an object.`);
    }
    return value;
  };
  const asArray = (value, label) => {
    if (!Array.isArray(value)) {
      throw new Error(`The backup is missing a ${label} list.`);
    }
    return value;
  };

  function validateBackup(backup, byteLength = 0) {
    if (byteLength > maxBackupBytes) {
      throw new Error("Backup is larger than 50 MB and was not imported.");
    }
    if (!backup || backup.format !== "leafreaderchrome-backup") {
      throw new Error("This is not a LeafReader Chrome backup.");
    }
    const version = Number(backup.version || 1);
    if (![1, 2].includes(version)) {
      throw new Error(`Unsupported backup version: ${backup.version}.`);
    }
    const documents = asArray(backup.documents, "documents");
    const annotations = asArray(backup.annotations, "annotations");
    const vocabulary = asArray(backup.vocabulary, "vocabulary");
    const settings = backup.settings
      ? asObject(backup.settings, "settings")
      : {};
    // Version 1 used the same aggregate names in exports. Keep this explicit
    // normalization so future storage migrations never make old backups vague.
    const aiConversations = asObject(
      backup.aiConversations || backup.conversations || {},
      "AI conversations",
    );
    const sidePanelThreads = asObject(
      backup.sidePanelThreads || backup.threads || {},
      "page trails",
    );
    return {
      ...backup,
      version: 2,
      documents,
      annotations,
      vocabulary,
      settings,
      aiConversations,
      sidePanelThreads,
    };
  }

  window.LeafReaderBackup = { validateBackup };
})();
