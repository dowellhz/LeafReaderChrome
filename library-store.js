(() => {
  const databaseName = "leafreaderchrome";
  const databaseVersion = 1;

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("documents")) {
          request.result.createObjectStore("documents", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readAll() {
    const database = await open();
    try {
      return await new Promise((resolve, reject) => {
        const request = database
          .transaction("documents")
          .objectStore("documents")
          .getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }

  async function replaceAll(documents) {
    const database = await open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("documents", "readwrite");
        const store = transaction.objectStore("documents");
        store.clear();
        documents.forEach((document) => store.put(document));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }

  window.LeafReaderLibraryStore = { open, readAll, replaceAll };
})();
