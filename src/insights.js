/* =====================================================================
 *  insights.js — local heuristics that make the ledger self-improving
 * =====================================================================
 *
 * No external calls. Pure functions over the task list and a tiny local
 * event log so the UI can offer smart defaults and gentle nudges.
 *
 * Event log shape (each entry):
 *   { ts, kind: "complete"|"snooze"|"delete"|"quick-add", taskId, meta? }
 */

import { storage } from "./storage.js";

const EVENT_LOG_KEY = "family_ledger_events_v1";
const MAX_EVENTS = 1000;

export async function loadEventLog() {
  try {
    const res = await storage.get(EVENT_LOG_KEY);
    return res?.value ? JSON.parse(res.value) : [];
  } catch {
    return [];
  }
}

export async function appendEvent(event) {
  try {
    const log = await loadEventLog();
    log.push({ ts: Date.now(), ...event });
    if (log.length > MAX_EVENTS) log.splice(0, log.length - MAX_EVENTS);
    await storage.set(EVENT_LOG_KEY, JSON.stringify(log));
  } catch {
    /* best effort */
  }
}

/* ---- smart-defaults ---------------------------------------------- */

/** Reorder a list of options by recency + frequency from the event log. */
export function rerankByUsage(options, events, keyOf) {
  if (!events?.length) return options;
  const score = new Map();
  const now = Date.now();
  events.forEach((e) => {
    if (e.kind !== "quick-add" || !e.meta) return;
    const key = keyOf(e.meta);
    if (!key) return;
    const ageDays = (now - e.ts) / 86400000;
    const decay = Math.max(0.1, 1 - ageDays / 30); // 30-day decay
    score.set(key, (score.get(key) || 0) + decay);
  });
  return [...options].sort((a, b) => (score.get(b.id) || 0) - (score.get(a.id) || 0));
}

/** Stale tasks: not completed in N days and not snoozed. */
export function findStaleTasks(tasks, days = 30) {
  const cutoff = Date.now() - days * 86400000;
  return tasks.filter((t) => {
    if (t.frequency === "once") return false;
    if (t.snoozedUntil && new Date(t.snoozedUntil) > new Date()) return false;
    const last = t.lastCompleted ? new Date(t.lastCompleted).getTime() : t.createdAt || 0;
    return last < cutoff;
  });
}

/** Detect snooze patterns: tasks that always get snoozed by ~N days. */
export function detectSnoozePatterns(events) {
  const byTask = new Map();
  events.forEach((e) => {
    if (e.kind !== "snooze") return;
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
    byTask.get(e.taskId).push(e.meta?.daysOut || 0);
  });
  const patterns = [];
  for (const [taskId, deltas] of byTask.entries()) {
    if (deltas.length < 3) continue;
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((a, b) => a + (b - avg) ** 2, 0) / deltas.length;
    if (variance < 4 && avg > 0) {
      patterns.push({ taskId, suggestedDays: Math.round(avg), confidence: deltas.length });
    }
  }
  return patterns;
}

/** Weekly throughput trend: completions in this vs last vs prior week. */
export function throughputTrend(tasks) {
  const buckets = [0, 0, 0]; // [this, last, prior]
  const now = new Date();
  const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const today = startOfDay(now);
  const dayOfWeek = today.getDay();
  const thisWeekStart = new Date(today);
  thisWeekStart.setDate(today.getDate() - dayOfWeek);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(thisWeekStart.getDate() - 7);
  const priorWeekStart = new Date(lastWeekStart);
  priorWeekStart.setDate(lastWeekStart.getDate() - 7);

  tasks.forEach((t) => {
    (t.completionHistory || []).forEach((iso) => {
      const d = startOfDay(iso);
      if (d >= thisWeekStart) buckets[0]++;
      else if (d >= lastWeekStart) buckets[1]++;
      else if (d >= priorWeekStart) buckets[2]++;
    });
  });
  return { thisWeek: buckets[0], lastWeek: buckets[1], priorWeek: buckets[2] };
}

/** Suggest promoting a quick-add to recurring if it's been added 3+ times. */
export function detectRepeatQuickAdds(events) {
  const byTitle = new Map();
  events.forEach((e) => {
    if (e.kind !== "quick-add") return;
    const title = (e.meta?.title || "").toLowerCase().trim();
    if (!title) return;
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(e.ts);
  });
  const suggestions = [];
  for (const [title, timestamps] of byTitle.entries()) {
    if (timestamps.length < 3) continue;
    // Spread across at least 14 days
    if (Math.max(...timestamps) - Math.min(...timestamps) > 14 * 86400000) {
      suggestions.push({ title, count: timestamps.length });
    }
  }
  return suggestions;
}
