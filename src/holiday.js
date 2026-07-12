/* =====================================================================
 *  holiday.js — Holiday Mode
 * =====================================================================
 *
 *  When the family is away, "home" tasks (House Care by default) are
 *  paused: they drop out of This Week, the Today digest, and daily
 *  notifications. Everything else keeps flowing.
 *
 *  When Holiday Mode is turned off, the home tasks that came due during
 *  the trip resurface as a "catch-up" list so nothing is silently lost.
 *
 *  State lives in settings.holidayMode:
 *    {
 *      active:       boolean,
 *      startedAt:    ISO string | null,   // when the current holiday began
 *      categories:   string[] | undefined, // which category ids count as "home"
 *      catchUpSince: ISO string | null,   // set on return, drives the catch-up banner
 *    }
 */

export const HOME_CATEGORY = "house-care";

/** Which category ids are treated as "home" and paused during a holiday. */
export function holidayCategories(settings) {
  const cats = settings?.holidayMode?.categories;
  if (Array.isArray(cats) && cats.length) return cats;
  return [HOME_CATEGORY];
}

export function isHolidayActive(settings) {
  return !!settings?.holidayMode?.active;
}

/** True if a task should be hidden right now because Holiday Mode is on. */
export function isSuppressedByHoliday(task, settings) {
  if (!isHolidayActive(settings)) return false;
  return holidayCategories(settings).includes(task?.category || "");
}

/** Filter a list of tasks for display, honoring Holiday Mode. */
export function filterHoliday(tasks, settings) {
  if (!isHolidayActive(settings)) return tasks || [];
  const cats = holidayCategories(settings);
  return (tasks || []).filter((t) => !cats.includes(t?.category || ""));
}

/** Build the next holidayMode object when turning the toggle ON. */
export function startHoliday(settings) {
  return {
    ...(settings?.holidayMode || {}),
    active: true,
    startedAt: new Date().toISOString(),
    categories: holidayCategories(settings),
    catchUpSince: null,
  };
}

/** Build the next holidayMode object when turning the toggle OFF. */
export function endHoliday(settings) {
  const prev = settings?.holidayMode || {};
  return {
    ...prev,
    active: false,
    catchUpSince: prev.startedAt || new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
}

/**
 * Home tasks that were missed during the last holiday and still need doing.
 * Returned only after a holiday ends (until the user dismisses the banner).
 */
export function catchUpTasks(tasks, settings) {
  const hm = settings?.holidayMode;
  if (!hm || hm.active || !hm.catchUpSince) return [];
  const since = new Date(hm.catchUpSince);
  const now = new Date();
  const cats = holidayCategories(settings);
  return (tasks || []).filter((t) => {
    if (!cats.includes(t?.category || "")) return false;
    if (t.done) return false;
    // Recurring home tasks were skipped every cycle we were away.
    if (t.frequency && t.frequency !== "once") return true;
    if (t.deadline) {
      const d = new Date(t.deadline);
      return d >= since && d <= now;
    }
    // Undated home to-dos simply resurface.
    return true;
  });
}

/** Clear the catch-up banner once the family has reviewed it. */
export function dismissCatchUp(settings) {
  return { ...(settings?.holidayMode || {}), catchUpSince: null };
}

/** Human-readable count of days the family has been (or was) away. */
export function holidayDays(settings) {
  const startedAt = settings?.holidayMode?.startedAt;
  if (!startedAt) return 0;
  const start = new Date(startedAt);
  const end = settings?.holidayMode?.active ? new Date() : new Date(settings?.holidayMode?.endedAt || Date.now());
  return Math.max(0, Math.round((end - start) / 86400000));
}
