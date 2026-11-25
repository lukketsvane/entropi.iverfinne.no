/** @typedef {{preset:number,position:number,width:number,contrast?:number,gamma?:number,look?:number,strength?:number,structure?:number,sharpen?:number,grain?:number,dither?:number,cell?:number,threshold?:number,invert?:boolean}} Recipe */
/** @typedef {{width:number,height:number,mask:Uint8Array|null,depth:Uint16Array,depthWidth:number,depthHeight:number,recipe:Recipe,photo?:Blob}} Item */
/** @typedef {{id:string,created:number,thumbnail:Blob|null}} Entry */
/** @typedef {{id:string,created:number,file:Blob,name:string,attempts:number}} Pending */

/** @param {IDBFactory} factory @returns {Promise<IDBDatabase>} */
function openGallery(factory) {
  return new Promise((resolve, reject) => {
    if (!factory) { reject(new Error('Lokal lagring er ikkje tilgjengeleg.')); return; }
    const request = factory.open('entropi-gallery-v1', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('index')) db.createObjectStore('index', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'id' });
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
  const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  return {
    /** Keep picked files until each one is developed, across reloads. @param {File[]} files */
    async enqueue(files) {
      const db = await connect(), now = Date.now();
      await transact(db, ['pending'], 'readwrite', transaction => {
        files.forEach((file, index) => transaction.objectStore('pending').put({ id: newId(), created: now + index, file, name: file.name, attempts: 0 }));
      });
    },
    /** Oldest first. @returns {Promise<Pending[]>} */
    async pending() {
      const db = await connect();
      /** @type {Pending[]} */ const jobs = await transact(db, ['pending'], 'readonly', transaction => transaction.objectStore('pending').getAll());
      return jobs.sort((a, b) => a.created - b.created);
    },
    /** @param {string} id */
    async drop(id) {
      const db = await connect();
      await transact(db, ['pending'], 'readwrite', transaction => { transaction.objectStore('pending').delete(id); });
    },
    /** @param {Pending} job */
    async retry(job) {
      const db = await connect();
      await transact(db, ['pending'], 'readwrite', transaction => { transaction.objectStore('pending').put({ ...job, attempts: job.attempts + 1 }); });
    },
    /** Store a developed upload and remove its pending file in one step. @param {string} pendingId @param {Item} item @param {Blob|null} thumbnail @returns {Promise<string>} */
    async complete(pendingId, item, thumbnail) {
      const db = await connect(), id = newId();
      await transact(db, ['index', 'items', 'pending'], 'readwrite', transaction => {
        transaction.objectStore('items').put({ id, ...item });
        transaction.objectStore('index').put({ id, created: Date.now(), thumbnail });
        transaction.objectStore('pending').delete(pendingId);
      });
      return id;
    },
    /** @param {Item} item @param {Blob|null} thumbnail @returns {Promise<string>} */
    async save(item, thumbnail) {
      if (!persisted) { persisted = true; void globalThis.navigator?.storage?.persist?.().catch(() => {}); }
      const db = await connect(), id = newId();
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
    },
    /** @param {string} id */
    async remove(id) {
      const db = await connect();
      await transact(db, ['index', 'items'], 'readwrite', transaction => {
        transaction.objectStore('items').delete(id);
        transaction.objectStore('index').delete(id);
      });
    }
  };
}
