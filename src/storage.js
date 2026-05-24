import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";

/**
 * Mirrors Claude's window.storage API shape so the app code didn't have to change.
 * Backed by IndexedDB via idb-keyval (tiny, ~600B).
 */
export const storage = {
  async get(key) {
    const value = await idbGet(key);
    return value !== undefined ? { key, value } : null;
  },
  async set(key, value) {
    await idbSet(key, value);
    return { key, value };
  },
  async delete(key) {
    await idbDel(key);
    return { key, deleted: true };
  },
};
