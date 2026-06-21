/* =================================================================
 *  reminders.js — Smart Reminders for birthdays, anniversaries, etc.
 * =================================================================
 *
 * Reminders are stored in the backend (Apps Script / Google Sheets).
 * Each reminder has:
 *   id, name, type (birthday|anniversary|holiday|custom),
 *   month (1-12), day (1-31), year (optional, for age tracking),
 *   leadDays (array, e.g. [60, 30, 14, 7]),
 *   giftfulUrl (optional Giftful wishlist link),
 *   assignedTo (who should be notified),
 *   notes
 */

const REMINDERS_KEY = "fl_reminders_v1";
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
let _cache = null;
let _cacheTs = 0;

// ── Types ──────────────────────────────────────────────────────────
export const REMINDER_TYPES = [
  { id: "birthday",     label: "Birthday",     emoji: "🎂" },
  { id: "anniversary",  label: "Anniversary",  emoji: "💍" },
  { id: "holiday",      label: "Holiday",      emoji: "🎄" },
  { id: "custom",       label: "Custom Event", emoji: "📅" },
];

export const DEFAULT_LEAD_DAYS = {
  birthday:    [60, 30, 14, 7],
  anniversary: [30, 14, 7],
  holiday:     [45, 21, 7],
  custom:      [14, 7],
};

// ── Persistence helpers ────────────────────────────────────────────
export function loadRemindersLocal() {
  try {
    const raw = localStorage.getItem(REMINDERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveRemindersLocal(reminders) {
  try { localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders)); } catch {}
}

// ── Backend sync ───────────────────────────────────────────────────
export async function loadRemindersFromBackend({ backendUrl, sharedSecret }) {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL) return _cache;
  try {
    const url = backendUrl + "?action=get-reminders&secret=" + encodeURIComponent(sharedSecret);
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    _cache = data.reminders || [];
    _cacheTs = now;
    saveRemindersLocal(_cache);
    return _cache;
  } catch (err) {
    console.warn("reminders: backend load failed, using local", err);
    return loadRemindersLocal();
  }
}

export async function saveRemindersToBackend({ backendUrl, sharedSecret, reminders }) {
  _cache = reminders;
  _cacheTs = Date.now();
  saveRemindersLocal(reminders);
  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save-reminders", secret: sharedSecret, reminders }),
    });
    if (!res.ok) throw new Error(res.statusText);
    return { ok: true };
  } catch (err) {
    console.warn("reminders: backend save failed", err);
    return { ok: false, error: err.message };
  }
}

// ── Date utilities ─────────────────────────────────────────────────
/**
 * Given a reminder, return the next occurrence date (this year or next).
 */
export function nextOccurrence(reminder) {
  const today = new Date();
  const thisYear = today.getFullYear();
  let d = new Date(thisYear, reminder.month - 1, reminder.day);
  if (d < today) d = new Date(thisYear + 1, reminder.month - 1, reminder.day);
  return d;
}

/**
 * Days until the next occurrence.
 */
export function daysUntil(reminder) {
  const next = nextOccurrence(reminder);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((next - today) / 86400000);
}

/**
 * Return age (if birth year stored) for this year's occurrence.
 */
export function ageThisYear(reminder) {
  if (!reminder.year) return null;
  const thisYear = new Date().getFullYear();
  return thisYear - reminder.year;
}

/**
 * Return all reminders that should fire a reminder task TODAY,
 * based on their leadDays settings.
 */
export function getDueReminders(reminders) {
  const due = [];
  for (const r of reminders) {
    const days = daysUntil(r);
    const leads = r.leadDays || DEFAULT_LEAD_DAYS[r.type] || [14, 7];
    for (const lead of leads) {
      if (days === lead) {
        due.push({ reminder: r, daysUntil: days, lead });
        break;
      }
    }
  }
  return due;
}

/**
 * Generate a suggested task title for a reminder that is coming up.
 */
export function reminderToTaskTitle(reminder, daysUntil) {
  const typeLabel = REMINDER_TYPES.find(t => t.id === reminder.type)?.label || "Event";
  const age = ageThisYear(reminder);
  const ageSuffix = age ? ` (${age}th)` : "";
  if (daysUntil <= 7) {
    return `${reminder.name}'s ${typeLabel}${ageSuffix} is in ${daysUntil} days — finalize plans`;
  }
  if (daysUntil <= 14) {
    return `Buy gift for ${reminder.name}'s ${typeLabel}${ageSuffix}`;
  }
  return `Plan for ${reminder.name}'s ${typeLabel}${ageSuffix} in ${daysUntil} days`;
}

/**
 * Build a full task object from a reminder.
 */
export function reminderToTask(reminder, daysUntil) {
  const next = nextOccurrence(reminder);
  const deadlineStr = next.toISOString().slice(0, 10);
  const age = ageThisYear(reminder);
  const ageSuffix = age ? ` (${reminder.name} turns ${age})` : "";
  return {
    id: "reminder-" + reminder.id + "-" + Date.now(),
    title: reminderToTaskTitle(reminder, daysUntil),
    details: [
      reminder.giftfulUrl ? `🎁 Giftful wishlist: ${reminder.giftfulUrl}` : "",
      reminder.notes || "",
      ageSuffix,
    ].filter(Boolean).join("\n"),
    category: "personal",
    assignedTo: reminder.assignedTo || "Anyone",
    frequency: "once",
    deadline: deadlineStr,
    priority: daysUntil <= 7 ? "high" : "medium",
    notify: true,
    repeat: "none",
    reminderSourceId: reminder.id,
  };
}

export function clearRemindersCache() {
  _cache = null;
  _cacheTs = 0;
}
