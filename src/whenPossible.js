/* =====================================================================
 *  whenPossible.js — the shared "When Possible" list
 * =====================================================================
 *
 *  A low-pressure, shared family list of "do it whenever you get a
 *  chance" items. Deliberately SEPARATE from the dated task ledger:
 *  no deadlines, no scheduling, no digest, no notifications. Just a
 *  running reminder anyone in the family can add to or tick off.
 *
 *  Item shape:
 *    { id, text, createdBy, ts, done, doneBy, doneTs }
 *
 *  Persisted to the Apps Script backend (mirrors reminders.js) with a
 *  localStorage cache for instant load + offline use.
 */

const WP_KEY = "fl_when_possible_v1";
const CACHE_TTL = 5 * 60 * 1000;
let _cache = null;
let _cacheTs = 0;

export function loadWhenPossibleLocal() {
  try {
    const raw = localStorage.getItem(WP_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveWhenPossibleLocal(items) {
  try { localStorage.setItem(WP_KEY, JSON.stringify(items)); } catch {}
}

export async function loadWhenPossibleFromBackend({ backendUrl, sharedSecret }) {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL) return _cache;
  if (!backendUrl) return loadWhenPossibleLocal();
  try {
    const url = backendUrl + "?action=get-when-possible&secret=" + encodeURIComponent(sharedSecret || "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    _cache = data.items || [];
    _cacheTs = now;
    saveWhenPossibleLocal(_cache);
    return _cache;
  } catch (err) {
    console.warn("whenPossible: backend load failed, using local", err);
    return loadWhenPossibleLocal();
  }
}

export async function saveWhenPossibleToBackend({ backendUrl, sharedSecret, items }) {
  _cache = items;
  _cacheTs = Date.now();
  saveWhenPossibleLocal(items);
  if (!backendUrl) return { ok: true, local: true };
  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save-when-possible", secret: sharedSecret || "", items }),
    });
    if (!res.ok) throw new Error(res.statusText);
    return { ok: true };
  } catch (err) {
    console.warn("whenPossible: backend save failed (kept locally)", err);
    return { ok: false, error: err.message };
  }
}

export function makeWhenPossibleItem({ text, createdBy }) {
  return {
    id: "wp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    text: String(text || "").trim(),
    createdBy: createdBy || "Someone",
    ts: new Date().toISOString(),
    done: false,
    doneBy: null,
    doneTs: null,
  };
}

export function clearWhenPossibleCache() { _cache = null; _cacheTs = 0; }
