import type { SaveRecord, SaveStorage } from "./types";

const DATABASE_NAME = "project-trw-save";
const DATABASE_VERSION = 1;
const STORE_NAME = "save";
const RECORD_KEY = "current";

export class IndexedDbSaveStorage implements SaveStorage {
  private databasePromise?: Promise<IDBDatabase>;

  constructor(private readonly indexedDbFactory?: IDBFactory) {}

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
    if (!this.databasePromise) {
      const factory = this.indexedDbFactory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
      if (!factory) {
        return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
      }
      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => {
            database.close();
            this.databasePromise = undefined;
          };
          resolve(database);
        };
        request.onerror = () => reject(request.error ?? new Error("Unable to open save database."));
        // A blocked upgrade may complete after another tab closes; keep waiting for success or error.
        request.onblocked = () => undefined;
      });
      this.databasePromise = opening.catch((error: unknown) => {
        this.databasePromise = undefined;
        throw error;
      });
    }
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
