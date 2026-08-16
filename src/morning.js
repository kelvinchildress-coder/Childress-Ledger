/* =====================================================================
 *  morning.js — personalized morning report
 * =====================================================================
 *
 *  Each family member sets their own interests (news topics, research
 *  topics, a daily Bible verse, and a free-form custom request). On the
 *  first open each day they get a full-screen, AI-summarized brief — the
 *  daily hook that pulls them into the ledger.
 *
 *  Interests are stored per person (keyed by name) and synced via the
 *  backend. Reports are generated on demand and cached locally per day.
 */

const CONFIG_KEY = "fl_morning_configs_v1";

export function defaultMorningConfig() {
  return { news: [], research: [], bible: true, custom: "" };
}

export function loadConfigsLocal() {
  try { const r = localStorage.getItem(CONFIG_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
}
export function saveConfigsLocal(map) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(map)); } catch {}
}

export async function loadMorningConfigs({ backendUrl, sharedSecret }) {
  if (!backendUrl) return loadConfigsLocal();
  try {
    const res = await fetch(backendUrl + "?action=get-morning-config&secret=" + encodeURIComponent(sharedSecret || ""));
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    const map = data.configs || {};
    saveConfigsLocal(map);
    return map;
  } catch { return loadConfigsLocal(); }
}

export async function saveMorningConfigs({ backendUrl, sharedSecret, configs }) {
  saveConfigsLocal(configs);
  if (!backendUrl) return { ok: true, local: true };
  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save-morning-config", secret: sharedSecret || "", configs }),
    });
    if (!res.ok) throw new Error(res.statusText);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function configFor(map, userName) {
  return (map && map[userName]) || defaultMorningConfig();
}

export function hasInterests(cfg) {
  return !!(cfg && ((cfg.news && cfg.news.length) || (cfg.research && cfg.research.length) || (cfg.custom && cfg.custom.trim()) || cfg.bible));
}

/* per-user, per-day report cache */
export function cachedReport(userName, date) {
  try {
    const r = localStorage.getItem("fl_morning_report_" + userName);
    if (!r) return null;
    const o = JSON.parse(r);
    return o.date === date ? o : null;
  } catch { return null; }
}
export function cacheReport(userName, report) {
  try { localStorage.setItem("fl_morning_report_" + userName, JSON.stringify(report)); } catch {}
}
export function seenToday(userName, date) {
  try { return localStorage.getItem("fl_morning_seen_" + userName) === date; } catch { return false; }
}
export function markSeen(userName, date) {
  try { localStorage.setItem("fl_morning_seen_" + userName, date); } catch {}
}

export async function fetchMorningReport({ backendUrl, sharedSecret, config, userName }) {
  if (!backendUrl) return { ok: false, error: "No backend configured for the morning report." };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "morning-report", secret: sharedSecret || "", config, userName }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error };
    return { ok: true, report: data };
  } catch (e) {
    return { ok: false, error: (e.name === "AbortError" ? "Timed out building your report." : (e.message || String(e))) };
  } finally { clearTimeout(t); }
}
