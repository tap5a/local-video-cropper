const DB_NAME = 'local-video-cropper';
const STORE = 'recents';
const MAX_RECENTS = 12;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const request = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      db.close();
      resolve(request?.result);
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}

export async function listRecents() {
  try {
    const all = (await tx('readonly', (s) => s.getAll())) ?? [];
    return all.sort((a, b) => b.lastOpened - a.lastOpened).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export async function saveRecent(entry) {
  try {
    await tx('readwrite', (s) => s.put(entry));
  } catch {
    // File handles aren't structured-cloneable in every browser — keep the
    // history entry anyway, it just won't be re-openable in one click.
    try {
      await tx('readwrite', (s) => s.put({ ...entry, handle: null }));
    } catch {}
  }
}

export async function deleteRecent(id) {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {}
}
