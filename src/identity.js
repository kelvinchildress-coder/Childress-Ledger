/* =====================================================================
 *  identity.js — "who am I" per-device picker
 * =====================================================================
 *
 * Stored locally per device. Used to:
 *   - stamp completedBy on every completion
 *   - power per-person streaks
 *   - drive the kid-themed celebration overlay
 *   - personalize the dashboard greeting
 */

import { storage } from "./storage.js";

const IDENTITY_KEY = "family_ledger_identity_v1";

// Hard-wired emojis for the Childress household. Add new family members here.
// Lookups are case-insensitive on first name.
const NAME_EMOJI = {
  "kelvin":   "\u{1F3C8}",  // 🏈 football — Nebraska Cornhuskers
  "enrique":  "\u{1F1F2}\u{1F1F9}",  // 🇲🇹 Maltese flag
  "andie":    "\u{1F3D0}",  // 🏐 volleyball (closest Unicode to beach volleyball)
  "noa":      "\u{1F370}",  // 🍰 piece of cake
};

const KID_EMOJI    = ["🦊", "🦄", "🐢", "🦖", "🐙", "🦋", "🐝", "🦔", "🦉", "🐼", "🦁", "🐧"];
const PARENT_EMOJI = ["📒", "✒️", "📓", "🗂️", "📚"];

/** Look up a custom emoji for a name; returns null if no match. */
export function customEmojiFor(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return NAME_EMOJI[key] || null;
}

export async function loadIdentity() {
  try {
    const res = await storage.get(IDENTITY_KEY);
    if (!res?.value) return null;
    const parsed = JSON.parse(res.value);
    // Live-refresh emoji if there's a custom mapping for this name.
    // This means existing saved identities get the new emoji on next load
    // without forcing the user to re-pick.
    const custom = customEmojiFor(parsed.name);
    if (custom && parsed.emoji !== custom) {
      parsed.emoji = custom;
      try { await storage.set(IDENTITY_KEY, JSON.stringify(parsed)); } catch {}
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveIdentity(identity) {
  try {
    await storage.set(IDENTITY_KEY, JSON.stringify(identity));
    return true;
  } catch {
    return false;
  }
}

export async function clearIdentity() {
  try {
    await storage.delete(IDENTITY_KEY);
    return true;
  } catch {
    return false;
  }
}

export function makeIdentity({ name, role }) {
  // Custom emoji takes precedence over the random-from-pool fallback.
  const custom = customEmojiFor(name);
  const pool = role === "kid" ? KID_EMOJI : PARENT_EMOJI;
  const emoji = custom || pool[Math.floor(Math.random() * pool.length)];
  return {
    id:
      "id_" +
      (name || "").toLowerCase().replace(/\s+/g, "_").slice(0, 16) +
      "_" +
      Math.random().toString(36).slice(2, 6),
    name: name?.trim() || "Someone",
    role: role === "kid" ? "kid" : "parent",
    emoji,
    createdAt: Date.now(),
  };
}

/* ---- attribution + leaderboard ---------------------------------- */

/** All completions in [start, end], flattened to {taskId, date, by}. */
export function flattenCompletions(tasks, start, end) {
  const out = [];
  tasks.forEach((t) => {
    const log = t.completionLog || [];
    log.forEach((entry) => {
      const d = new Date(entry.date);
      if (d >= start && d <= end) out.push({ ...entry, taskId: t.id, title: t.title });
    });
    if (!t.completionLog) {
      (t.completionHistory || []).forEach((iso) => {
        const d = new Date(iso);
        if (d >= start && d <= end) out.push({ date: iso, by: "Family", taskId: t.id, title: t.title });
      });
    }
  });
  return out;
}

export function weeklyLeaderboard(tasks, start, end) {
  const tally = new Map();
  flattenCompletions(tasks, start, end).forEach((c) => {
    const k = c.by || "Family";
    tally.set(k, (tally.get(k) || 0) + 1);
  });
  return [...tally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** Streak counted only across one person's completions. */
export function personalDailyStreak(tasks, personName) {
  const dates = new Set();
  tasks.forEach((t) => {
    if (t.frequency !== "daily") return;
    (t.completionLog || []).forEach((e) => {
      if (e.by === personName) dates.add(e.date);
    });
  });
  if (dates.size === 0) return 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const toISO = (d) => d.toISOString().split("T")[0];
  if (!dates.has(toISO(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (dates.has(toISO(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
