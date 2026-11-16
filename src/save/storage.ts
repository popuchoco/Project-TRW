import type { SaveRecord, SaveStorage } from "./types";

const DATABASE_NAME = "project-trw-save";
const DATABASE_VERSION = 1;
const STORE_NAME = "save";
const RECORD_KEY = "current";

export class IndexedDbSaveStorage implements SaveStorage {
  private databasePromise?: Promise<IDBDatabase>;

  read(): Promise<unknown | undefined> {
    return this.withStore("readonly", (store) => {
      const request = store.get(RECORD_KEY);
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result as unknown | undefined);
        request.onerror = () => reject(request.error ?? new Error("Unable to read save data."));
      });
    });
  }

  write(record: SaveRecord): Promise<void> {
    return this.withStore("readwrite", (store) => {
      const request = store.put(record, RECORD_KEY);
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error("Unable to write save data."));
      });
    });
  }

  private open(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is unavailable in this browser."));
        return;
      }
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open save database."));
      request.onblocked = () => reject(new Error("Save database upgrade is blocked by another tab."));
    });
    return this.databasePromise;
  }

  private async withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, mode);
    const transactionComplete = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Save transaction failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Save transaction was aborted."));
    });
    try {
      const result = await operation(transaction.objectStore(STORE_NAME));
      await transactionComplete;
      return result;
    } catch (error) {
      await transactionComplete.catch(() => undefined);
      throw error;
    }
  }
}
