/* =====================================================================
 *  subscriptions.js — Subscriptions & Benefits tracker
 * =====================================================================
 *
 *  Tracks two kinds of recurring things:
 *    - "bill":    money going OUT on a schedule (Netflix, insurance…)
 *    - "benefit": a perk/credit coming IN on a schedule that must be
 *                 USED before it expires (e.g. Chase Sapphire Reserve
 *                 $150 StubHub credit every 6 months).
 *
 *  The goal is Personal-Assistant behavior: never miss a renewal, and
 *  never leave a benefit on the table.
 *
 *  Sub shape:
 *    {
 *      id, name, kind: "bill"|"benefit",
 *      amount,                 // dollars per cycle (number)
 *      cadence,                // one of SUB_CADENCES ids
 *      anchorDate,             // ISO date the cycle is measured from
 *      account,                // card / account it lives on
 *      notes,
 *      active,                 // false = archived
 *      // benefit-only tracking:
 *      usage: { [cycleKey]: { usedAt, by } }   // which cycles were used
 *    }
 *
 *  Persisted to Apps Script (mirrors reminders.js) with a local cache.
 */

const SUBS_KEY = "fl_subscriptions_v1";
const CACHE_TTL = 5 * 60 * 1000;
let _cache = null;
let _cacheTs = 0;

export const SUB_CADENCES = [
  { id: "weekly",     label: "Weekly",        months: 0, days: 7 },
  { id: "monthly",    label: "Monthly",       months: 1 },
  { id: "quarterly",  label: "Quarterly",     months: 3 },
  { id: "semiannual", label: "Every 6 months", months: 6 },
  { id: "annual",     label: "Annual",        months: 12 },
];

export function loadSubsLocal() {
  try {
    const raw = localStorage.getItem(SUBS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
export function saveSubsLocal(subs) {
  try { localStorage.setItem(SUBS_KEY, JSON.stringify(subs)); } catch {}
}

export async function loadSubsFromBackend({ backendUrl, sharedSecret }) {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL) return _cache;
  if (!backendUrl) return loadSubsLocal();
  try {
    const url = backendUrl + "?action=get-subs&secret=" + encodeURIComponent(sharedSecret || "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    _cache = data.subs || [];
    _cacheTs = now;
    saveSubsLocal(_cache);
    return _cache;
  } catch (err) {
    console.warn("subs: backend load failed, using local", err);
    return loadSubsLocal();
  }
}

export async function saveSubsToBackend({ backendUrl, sharedSecret, subs }) {
  _cache = subs;
  _cacheTs = Date.now();
  saveSubsLocal(subs);
  if (!backendUrl) return { ok: true, local: true };
  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save-subs", secret: sharedSecret || "", subs }),
    });
    if (!res.ok) throw new Error(res.statusText);
    return { ok: true };
  } catch (err) {
    console.warn("subs: backend save failed (kept locally)", err);
    return { ok: false, error: err.message };
  }
}

export function makeSub({ name, kind, amount, cadence, anchorDate, account, notes }) {
  return {
    id: "sub_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    name: String(name || "").trim(),
    kind: kind === "benefit" ? "benefit" : "bill",
    amount: Number(amount) || 0,
    cadence: cadence || "monthly",
    anchorDate: anchorDate || new Date().toISOString().slice(0, 10),
    account: account || "",
    notes: notes || "",
    active: true,
    usage: {},
    createdAt: new Date().toISOString(),
  };
}

function cadenceOf(sub) {
  return SUB_CADENCES.find((c) => c.id === sub.cadence) || SUB_CADENCES[1];
}

function addCadence(date, cad) {
  const d = new Date(date);
  if (cad.days) d.setDate(d.getDate() + cad.days);
  else d.setMonth(d.getMonth() + (cad.months || 1));
  return d;
}

/** Start date of the cycle that contains `ref` (default now). */
export function currentCycleStart(sub, ref = new Date()) {
  const cad = cadenceOf(sub);
  let d = new Date(sub.anchorDate);
  let guard = 0;
  while (addCadence(d, cad) <= ref && guard < 1000) { d = addCadence(d, cad); guard++; }
  return d;
}

/** Next occurrence (renewal for a bill, or cycle rollover for a benefit). */
export function nextSubDate(sub, ref = new Date()) {
  const cad = cadenceOf(sub);
  return addCadence(currentCycleStart(sub, ref), cad);
}

/** A stable key for the current cycle, used to record benefit usage. */
export function currentCycleKey(sub, ref = new Date()) {
  return currentCycleStart(sub, ref).toISOString().slice(0, 10);
}

export function isBenefitUsedThisCycle(sub, ref = new Date()) {
  const key = currentCycleKey(sub, ref);
  return !!(sub.usage && sub.usage[key]);
}

export function daysUntilNext(sub, ref = new Date()) {
  const next = nextSubDate(sub, ref);
  const r = new Date(ref); r.setHours(0, 0, 0, 0);
  return Math.round((next - r) / 86400000);
}

/** Bills renewing within `days` days. */
export function subsDueSoon(subs, days = 7) {
  return (subs || [])
    .filter((s) => s.active !== false && s.kind === "bill")
    .map((s) => ({ sub: s, days: daysUntilNext(s) }))
    .filter((x) => x.days >= 0 && x.days <= days)
    .sort((a, b) => a.days - b.days);
}

/** Benefits not yet used this cycle — the "money on the table" list. */
export function benefitsToUse(subs) {
  return (subs || [])
    .filter((s) => s.active !== false && s.kind === "benefit")
    .filter((s) => !isBenefitUsedThisCycle(s))
    .map((s) => ({ sub: s, days: daysUntilNext(s) }))
    .sort((a, b) => a.days - b.days);
}

/** Total recurring monthly bill spend (normalized to a month). */
export function monthlyBillTotal(subs) {
  const perMonth = (s) => {
    const cad = cadenceOf(s);
    if (cad.days) return (s.amount || 0) * (30 / cad.days);
    return (s.amount || 0) / (cad.months || 1);
  };
  return (subs || [])
    .filter((s) => s.active !== false && s.kind === "bill")
    .reduce((sum, s) => sum + perMonth(s), 0);
}

export function markBenefitUsed(sub, by) {
  const key = currentCycleKey(sub);
  const usage = { ...(sub.usage || {}), [key]: { usedAt: new Date().toISOString(), by: by || "Family" } };
  return { ...sub, usage };
}

export function clearSubsCache() { _cache = null; _cacheTs = 0; }
