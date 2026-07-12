/* =====================================================================
 *  notes.js — simple family notes with per-person visibility
 * =====================================================================
 *
 *  A note is a short message left for one person, a combination of
 *  people, or the whole family. Each viewer only sees notes addressed
 *  to them (or to everyone).
 *
 *  Note shape:
 *    {
 *      id, text,
 *      author,             // display name of who wrote it
 *      authorId,           // identity id of who wrote it
 *      visibility,         // ["__everyone__"] OR ["Kelvin","Andie"]
 *      ts,                 // ISO timestamp
 *      done?               // optional: mark a note as handled
 *    }
 *
 *  Stored in the Apps Script backend (mirrors reminders.js), with a
 *  localStorage cache so notes survive offline and appear instantly.
 */

const NOTES_KEY = "fl_notes_v1";
const CACHE_TTL = 5 * 60 * 1000;
let _cache = null;
let _cacheTs = 0;

export const VISIBILITY_EVERYONE = "__everyone__";

export function loadNotesLocal() {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveNotesLocal(notes) {
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch {}
}

export async function loadNotesFromBackend({ backendUrl, sharedSecret }) {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL) return _cache;
  if (!backendUrl) return loadNotesLocal();
  try {
    const url = backendUrl + "?action=get-notes&secret=" + encodeURIComponent(sharedSecret || "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    _cache = data.notes || [];
    _cacheTs = now;
    saveNotesLocal(_cache);
    return _cache;
  } catch (err) {
    console.warn("notes: backend load failed, using local", err);
    return loadNotesLocal();
  }
}

export async function saveNotesToBackend({ backendUrl, sharedSecret, notes }) {
  _cache = notes;
  _cacheTs = Date.now();
  saveNotesLocal(notes);
  if (!backendUrl) return { ok: true, local: true };
  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save-notes", secret: sharedSecret || "", notes }),
    });
    if (!res.ok) throw new Error(res.statusText);
    return { ok: true };
  } catch (err) {
    console.warn("notes: backend save failed (kept locally)", err);
    return { ok: false, error: err.message };
  }
}

export function makeNote({ text, author, authorId, visibility }) {
  const vis = Array.isArray(visibility) && visibility.length ? visibility : [VISIBILITY_EVERYONE];
  return {
    id: "note_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    text: String(text || "").trim(),
    author: author || "Someone",
    authorId: authorId || null,
    visibility: vis,
    ts: new Date().toISOString(),
    done: false,
  };
}

/** True if this identity is allowed to see the note. */
export function canSeeNote(note, identity) {
  const vis = note?.visibility || [VISIBILITY_EVERYONE];
  if (vis.includes(VISIBILITY_EVERYONE)) return true;
  const name = identity?.name;
  if (name && vis.includes(name)) return true;
  // Authors always see their own notes.
  if (identity?.id && note?.authorId && identity.id === note.authorId) return true;
  return false;
}

/** All notes this identity can see, newest first. */
export function visibleNotes(notes, identity) {
  return (notes || [])
    .filter((n) => canSeeNote(n, identity))
    .sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

/** Short human label for a note's audience. */
export function audienceLabel(note) {
  const vis = note?.visibility || [VISIBILITY_EVERYONE];
  if (vis.includes(VISIBILITY_EVERYONE)) return "Everyone";
  return vis.join(", ");
}

export function clearNotesCache() { _cache = null; _cacheTs = 0; }
