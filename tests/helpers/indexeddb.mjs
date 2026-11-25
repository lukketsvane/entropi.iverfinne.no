export function memoryIndexedDB() {
  const stores = new Map();
  let created = false;
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name, { keyPath }) { stores.set(name, { keyPath, rows: new Map() }); },
    transaction() {
      let pending = 0, aborted = false;
      const transaction = {
        error: null,
        abort() { aborted = true; queueMicrotask(() => transaction.onabort?.()); },
        objectStore(name) {
          const store = stores.get(name);
          const request = run => {
            const result = {}; pending++;
            queueMicrotask(() => {
              result.result = run(); result.onsuccess?.();
              if (--pending === 0) queueMicrotask(() => { if (!pending && !aborted) transaction.oncomplete?.(); });
            });
            return result;
          };
          return {
            put: value => request(() => { store.rows.set(value[store.keyPath], structuredClone(value)); return value[store.keyPath]; }),
            get: key => request(() => structuredClone(store.rows.get(key))),
            getAll: () => request(() => [...store.rows.values()].map(value => structuredClone(value)))
          };
        }
      };
      return transaction;
    }
  };
  return { open() {
    const request = {};
    queueMicrotask(() => { request.result = db; if (!created) { created = true; request.onupgradeneeded?.(); } request.onsuccess?.(); });
    return request;
  } };
}
