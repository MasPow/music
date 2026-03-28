/**
 * db.js — IndexedDB abstraction for Waveline Music Player
 *
 * FIXES applied:
 *  1. onupgradeneeded no longer shadows module-level db via `const db`
 *  2. putSong() added for updating existing records (duration, etc.)
 *  3. addSong() strips `id` before insert so autoIncrement works reliably
 *  4. addPlaylist() strips `id` before insert
 *  5. tx() helper handles both IDBRequest and bare-transaction patterns
 */

const DB_NAME    = 'WavelineDB';
const DB_VERSION = 1;

let dbInstance = null;

// ─── OPEN ─────────────────────────────────────────────────────────────────────

export function openDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) return resolve(dbInstance);

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      // Use a distinct name to avoid shadowing the module-level `dbInstance`
      const upgradeDb = e.target.result;

      if (!upgradeDb.objectStoreNames.contains('songs')) {
        const songStore = upgradeDb.createObjectStore('songs', {
          keyPath: 'id',
          autoIncrement: true,
        });
        songStore.createIndex('title', 'title', { unique: false });
      }

      if (!upgradeDb.objectStoreNames.contains('playlists')) {
        upgradeDb.createObjectStore('playlists', {
          keyPath: 'id',
          autoIncrement: true,
        });
      }
    };

    req.onsuccess = (e) => {
      dbInstance = e.target.result;
      dbInstance.onversionchange = () => {
        dbInstance.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    req.onerror   = (e) => reject(e.target.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

// ─── HELPER ───────────────────────────────────────────────────────────────────

function tx(storeName, mode, callback) {
  return openDB().then((database) => {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);

      let request;
      try {
        request = callback(store);
      } catch (err) {
        return reject(err);
      }

      // IDBRequest path (add, put, get, delete, etc.)
      if (request && typeof request.onsuccess !== 'undefined') {
        request.onsuccess = () => resolve(request.result);
        request.onerror   = () => reject(request.error);
      } else {
        // No request — resolve on transaction completion
        transaction.oncomplete = () => resolve();
        transaction.onerror    = () => reject(transaction.error);
      }
    });
  });
}

// ─── SONGS ────────────────────────────────────────────────────────────────────

/** Insert a new song. Strips `id` so autoIncrement assigns one. Returns new id. */
export function addSong(song) {
  const record = Object.assign({}, song);
  delete record.id;
  return tx('songs', 'readwrite', (store) => store.add(record));
}

/** Overwrite an existing song record (must carry correct `id`). */
export function putSong(song) {
  return tx('songs', 'readwrite', (store) => store.put(song));
}

/** Return all song records (including blob). */
export function getAllSongs() {
  return openDB().then((database) => {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('songs', 'readonly');
      const store = transaction.objectStore('songs');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  });
}

/** Return a single song record by numeric id. */
export function getSong(id) {
  return tx('songs', 'readonly', (store) => store.get(id));
}

/** Delete a song by id. */
export function deleteSong(id) {
  return tx('songs', 'readwrite', (store) => store.delete(id));
}

// ─── PLAYLISTS ────────────────────────────────────────────────────────────────

/** Insert a new playlist. Strips `id` so autoIncrement assigns one. */
export function addPlaylist(playlist) {
  const record = Object.assign({}, playlist);
  delete record.id;
  return tx('playlists', 'readwrite', (store) => store.add(record));
}

/** Return all playlist records. */
export function getAllPlaylists() {
  return openDB().then((database) => {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('playlists', 'readonly');
      const store = transaction.objectStore('playlists');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  });
}

/** Overwrite an existing playlist (must carry correct `id`). */
export function updatePlaylist(playlist) {
  return tx('playlists', 'readwrite', (store) => store.put(playlist));
}

/** Delete a playlist by id. */
export function deletePlaylist(id) {
  return tx('playlists', 'readwrite', (store) => store.delete(id));
}
