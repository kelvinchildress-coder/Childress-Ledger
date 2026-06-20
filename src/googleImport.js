/* =====================================================================
 * googleImport.js — Google Services integration helpers
 * =====================================================================
 *
 * Provides functions to import and search data from Gmail, Google
 * Calendar, and Google Tasks (which sync with Google Keep checklists).
 *
 * How it works:
 *   - All API calls are proxied through the Apps Script backend.
 *   - The Apps Script runs as the script owner, so it already has
 *     access to their Gmail, Calendar, and Tasks — no browser OAuth
 *     flow is required.
 *   - Results are returned as raw data that can be fed to the AI
 *     brainstorm flow or displayed in the UI for task creation.
 *
 * Usage:
 *   import { fetchGoogleContext, searchGoogleServices, googleContextToPrompt }
 *     from "./googleImport.js";
 */

import { importFromGoogle, searchGoogle } from "./sync.js";

/* ── Types (JSDoc) ───────────────────────────────────────────────── */
/**
 * @typedef {Object} GoogleEmail
 * @property {string} subject
 * @property {string} from
 * @property {string} snippet
 * @property {string} date       ISO string
 * @property {string} id
 *
 * @typedef {Object} GoogleEvent
 * @property {string}  title
 * @property {string}  start     ISO string
 * @property {string}  end       ISO string
 * @property {string}  calendar
 * @property {string}  description
 * @property {string}  id
 * @property {boolean} isAllDay
 *
 * @typedef {Object} GoogleTask
 * @property {string}      title
 * @property {string}      notes
 * @property {string|null} due   ISO string or null
 * @property {string}      status
 * @property {string}      list
 * @property {string}      id
 *
 * @typedef {Object} GoogleContext
 * @property {GoogleEmail[]} emails
 * @property {GoogleEvent[]} events
 * @property {GoogleTask[]}  tasks
 * @property {Object[]}      errors
 * @property {boolean}       ok
 * @property {string|null}   errorMessage
 */

/* ── Cache ───────────────────────────────────────────────────────── */
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function clearGoogleCache() {
  _cache = null;
  _cacheTs = 0;
}

/* ── Main API ────────────────────────────────────────────────────── */

/**
 * Fetches Gmail threads, Calendar events, and Tasks from the backend.
 * Results are cached for 5 minutes.
 *
 * @param {string} backendUrl
 * @param {string} sharedSecret
 * @param {Object} [opts]
 * @param {number} [opts.maxEmails=10]
 * @param {number} [opts.maxEvents=15]
 * @param {number} [opts.maxTasks=20]
 * @param {number} [opts.daysAhead=14]
 * @param {boolean} [opts.forceRefresh=false]
 * @returns {Promise<GoogleContext>}
 */
export async function fetchGoogleContext(backendUrl, sharedSecret, opts = {}) {
  const { forceRefresh = false, ...fetchOpts } = opts;

  if (!forceRefresh && _cache && Date.now() - _cacheTs < CACHE_TTL_MS) {
    return _cache;
  }

  const result = await importFromGoogle(backendUrl, sharedSecret, fetchOpts);

  if (!result.ok) {
    return {
      ok: false,
      emails: [],
      events: [],
      tasks: [],
      errors: [],
      errorMessage: result.error?.message || "Failed to connect to Google services.",
    };
  }

  const ctx = {
    ok: true,
    emails: result.data.emails || [],
    events: result.data.events || [],
    tasks:  result.data.tasks  || [],
    errors: result.data.errors || [],
    errorMessage: null,
  };

  _cache   = ctx;
  _cacheTs = Date.now();
  return ctx;
}

/**
 * Searches Gmail, Calendar, and/or Tasks for a specific query.
 * Not cached (always fresh).
 *
 * @param {string}   backendUrl
 * @param {string}   sharedSecret
 * @param {string}   query
 * @param {string[]} [services=["gmail","calendar","tasks"]]
 * @returns {Promise<GoogleContext>}
 */
export async function searchGoogleServices(backendUrl, sharedSecret, query, services) {
  const result = await searchGoogle(backendUrl, query, sharedSecret, services);

  if (!result.ok) {
    return {
      ok: false,
      emails: [],
      events: [],
      tasks:  [],
      errors: [],
      errorMessage: result.error?.message || "Search failed.",
    };
  }

  return {
    ok: true,
    emails: result.data.emails || [],
    events: result.data.events || [],
    tasks:  result.data.tasks  || [],
    errors: result.data.errors || [],
    errorMessage: null,
    query,
  };
}

/**
 * Converts Google context into a plain-text prompt section that can be
 * injected into the AI brainstorm prompt for richer, context-aware suggestions.
 *
 * @param {GoogleContext} ctx
 * @param {Object} [opts]
 * @param {number} [opts.maxEmails=5]
 * @param {number} [opts.maxEvents=5]
 * @param {number} [opts.maxTasks=5]
 * @returns {string}
 */
export function googleContextToPrompt(ctx, opts = {}) {
  if (!ctx || !ctx.ok) return "";
  const { maxEmails = 5, maxEvents = 5, maxTasks = 5 } = opts;
  const lines = ["## Current Google Context"];

  if (ctx.emails.length > 0) {
    lines.push("\n### Recent Gmail Threads");
    ctx.emails.slice(0, maxEmails).forEach((e) => {
      const d = e.date ? new Date(e.date).toLocaleDateString() : "";
      lines.push(`- [${d}] From: ${e.from}\n  Subject: ${e.subject}`);
      if (e.snippet && e.snippet !== e.subject) {
        lines.push(`  Snippet: ${e.snippet.substring(0, 100)}`);
      }
    });
  }

  if (ctx.events.length > 0) {
    lines.push("\n### Upcoming Calendar Events");
    ctx.events.slice(0, maxEvents).forEach((ev) => {
      const start = ev.start ? new Date(ev.start).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
      const allDay = ev.isAllDay ? " (all-day)" : "";
      lines.push(`- [${start}${allDay}] ${ev.title} (calendar: ${ev.calendar})`);
      if (ev.description) {
        lines.push(`  ${ev.description.substring(0, 100)}`);
      }
    });
  }

  if (ctx.tasks.length > 0) {
    lines.push("\n### Existing Google Tasks / Keep Items");
    ctx.tasks.slice(0, maxTasks).forEach((t) => {
      const due = t.due ? ` [due: ${new Date(t.due).toLocaleDateString()}]` : "";
      lines.push(`- [${t.list}]${due} ${t.title}`);
      if (t.notes) {
        lines.push(`  Notes: ${t.notes.substring(0, 100)}`);
      }
    });
  }

  if (lines.length === 1) return ""; // Only the header, nothing useful
  return lines.join("\n");
}

/**
 * Checks if a Google Task (or Keep item) with a similar title already exists.
 * Returns the matching task(s) from ctx.tasks, or [] if none found.
 *
 * @param {string}       taskTitle
 * @param {GoogleTask[]} tasks
 * @param {number}       [threshold=0.6]  similarity threshold (0–1)
 * @returns {GoogleTask[]}
 */
export function findSimilarGoogleTasks(taskTitle, tasks, threshold = 0.6) {
  if (!taskTitle || !tasks || tasks.length === 0) return [];
  const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const needle = normalise(taskTitle);
  const needleWords = new Set(needle.split(/\s+/).filter(Boolean));

  return tasks.filter((t) => {
    const hay = normalise(t.title);
    const hayWords = new Set(hay.split(/\s+/).filter(Boolean));
    // Jaccard similarity on words
    const intersection = [...needleWords].filter((w) => hayWords.has(w)).length;
    const union = new Set([...needleWords, ...hayWords]).size;
    return union > 0 && intersection / union >= threshold;
  });
}

export { clearGoogleCache };
