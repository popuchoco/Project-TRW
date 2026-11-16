export async function requestPersistentStorage(): Promise<void> {
  try {
    const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
    if (!storage?.persist) {
      console.info("Persistent storage is unavailable; browser storage may be evicted.");
      return;
    }
    const granted = await storage.persist();
    if (!granted) console.info("Persistent storage was not granted; browser storage may be evicted.");
  } catch (error) {
    console.info("Persistent storage request failed.", error);
  }
}
