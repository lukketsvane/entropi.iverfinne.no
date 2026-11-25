/** @typedef {{preset:number,position:number,width:number}} Recipe */
/** @typedef {{width:number,height:number,mask:Uint8Array|null,depth:Uint16Array,depthWidth:number,depthHeight:number,recipe:Recipe}} Item */
/** @typedef {{id:string,created:number,thumbnail:Blob|null}} Entry */

/** @param {IDBFactory} factory @returns {Promise<IDBDatabase>} */
function openGallery(factory) {
  return new Promise((resolve, reject) => {
    if (!factory) { reject(new Error('Lokal lagring er ikkje tilgjengeleg.')); return; }
    const request = factory.open('entropi-gallery-v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('index')) db.createObjectStore('index', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** @template T @param {IDBDatabase} db @param {string[]} stores @param {IDBTransactionMode} mode
 * @param {(transaction: IDBTransaction) => {result?: T} | void} action @returns {Promise<T>} */
function transact(db, stores, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    /** @type {{result?: T} | void} */ let request;
    try { request = action(transaction); } catch (error) { transaction.abort(); reject(error); return; }
    transaction.oncomplete = () => resolve(/** @type {T} */ (request?.result));
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Lagringa vart avbroten.'));
  });
}

/** Developed depth images, kept on this device only. */
export function createGallery(factory = globalThis.indexedDB) {
  /** @type {Promise<IDBDatabase> | null} */ let opening = null;
  const connect = () => opening ??= openGallery(factory).catch(error => { opening = null; throw error; });
  let persisted = false;
  return {
    /** @param {Item} item @param {Blob|null} thumbnail @returns {Promise<string>} */
    async save(item, thumbnail) {
      if (!persisted) { persisted = true; void globalThis.navigator?.storage?.persist?.().catch(() => {}); }
      const db = await connect(), id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      await transact(db, ['index', 'items'], 'readwrite', transaction => {
        transaction.objectStore('items').put({ id, ...item });
        transaction.objectStore('index').put({ id, created: Date.now(), thumbnail });
      });
      return id;
    },
    /** @param {string} id @param {Recipe} recipe @param {Blob|null} thumbnail */
    async update(id, recipe, thumbnail) {
      const db = await connect();
      await transact(db, ['index', 'items'], 'readwrite', transaction => {
        const items = transaction.objectStore('items'), index = transaction.objectStore('index');
        const item = items.get(id), entry = index.get(id);
        entry.onsuccess = () => {
          if (!item.result || !entry.result) return;
          items.put({ ...item.result, recipe });
          index.put({ ...entry.result, thumbnail: thumbnail ?? entry.result.thumbnail });
        };
      });
    },
    /** Newest first. @returns {Promise<Entry[]>} */
    async list() {
      const db = await connect();
      /** @type {Entry[]} */ const entries = await transact(db, ['index'], 'readonly', transaction => transaction.objectStore('index').getAll());
      return entries.sort((a, b) => b.created - a.created);
    },
    /** @param {string} id @returns {Promise<(Item & {id:string}) | undefined>} */
    async get(id) {
      const db = await connect();
      return transact(db, ['items'], 'readonly', transaction => transaction.objectStore('items').get(id));
    }
  };
}
