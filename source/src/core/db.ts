import type { Doc } from './types';

// Tiny IndexedDB wrapper. Documents never leave the device.
const DB = 'docscan';
const STORE = 'docs';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(r.result);
        };
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const listDocs = async (): Promise<Doc[]> => {
  try {
    const all = await tx<Doc[]>('readonly', (s) => s.getAll());
    return all.sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
};
export const saveDoc = (d: Doc) => tx('readwrite', (s) => s.put(d)).catch(() => undefined);
export const deleteDoc = (id: string) => tx('readwrite', (s) => s.delete(id)).catch(() => undefined);
