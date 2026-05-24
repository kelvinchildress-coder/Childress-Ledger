/* =====================================================================
 *  sync.js — talking to the Apps Script backend
 * =====================================================================
 *
 * Wraps every fetch to the Apps Script Web App and returns rich result
 * objects: { ok, data?, error?: { kind, status?, message, hint? } }
 *
 * Notes that matter:
 *  - We do NOT set { mode: "cors" } explicitly anymore. Apps Script
 *    issues a 302 → script.googleusercontent.com redirect, and some
 *    sandboxes choke on the explicit "cors" mode + redirect combo.
 *  - POSTs use Content-Type: text/plain to avoid a CORS preflight.
 *    Apps Script still parses the JSON body correctly — don't "fix" it.
 *  - All requests get an 8-second timeout via AbortController so the UI
 *    never hangs waiting on a dead URL.
 */

const DEFAULT_TIMEOUT_MS = 8000;

/** Categorise an error so the UI can show a useful hint. */
function classify(err, res) {
  if (res && !res.ok) {
    return {
      kind: "http",
      status: res.status,
      message: `Server returned ${res.status} ${res.statusText || ""}`.trim(),
      hint:
        res.status === 401 || res.status === 403
          ? "Deployment access is probably not set to 'Anyone'. Re-deploy with Who has access = Anyone."
          : res.status === 404
          ? "URL looks wrong. Check Manage Deployments for the /exec URL (not /dev)."
          : "Open the URL in a browser tab to see what it returns.",
    };
  }
  const msg = err?.message || String(err || "unknown");
  if (/aborted|timeout/i.test(msg)) {
    return { kind: "timeout", message: "Request timed out (8s). Network or Apps Script is slow.", hint: "Try again, or check Apps Script Executions log." };
  }
  if (/Failed to fetch|NetworkError|TypeError/i.test(msg)) {
    return {
      kind: "network",
      message: "Network/CORS error. Browser couldn't reach the URL.",
      hint:
        "Most common cause: deployment access is not set to 'Anyone'. " +
        "Open the URL in a fresh browser tab — if you see a Google sign-in, fix the deployment.",
    };
  }
  return { kind: "unknown", message: msg };
}

async function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await promise(ctl.signal);
  } finally {
    clearTimeout(t);
  }
}

function appendQuery(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") u.searchParams.set(k, v);
  }
  return u.toString();
}

/** GET ?action=ping. Cheapest possible round-trip. */
export async function pingBackend(url, sharedSecret) {
  if (!url) return { ok: false, error: { kind: "config", message: "No backend URL set." } };
  try {
    const res = await withTimeout((signal) =>
      fetch(appendQuery(url, { action: "ping", secret: sharedSecret || "" }), { method: "GET", signal })
    );
    if (!res.ok) return { ok: false, error: classify(null, res) };
    const data = await res.json().catch(() => ({}));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: classify(e) };
  }
}

/** GET ?action=load — returns { tasks, lastModified, ... } */
export async function loadFromBackend(url, sharedSecret) {
  if (!url) return { ok: false, error: { kind: "config", message: "No backend URL set." } };
  try {
    const res = await withTimeout((signal) =>
      fetch(appendQuery(url, { action: "load", secret: sharedSecret || "" }), { method: "GET", signal })
    );
    if (!res.ok) return { ok: false, error: classify(null, res) };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: classify(e) };
  }
}

/** POST { action: "save", data } — body is text/plain JSON. */
export async function syncToBackend(url, payload, sharedSecret) {
  if (!url) return { ok: false, error: { kind: "config", message: "No backend URL set." } };
  try {
    const res = await withTimeout(
      (signal) =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "save", secret: sharedSecret || "", data: payload }),
          signal,
        }),
      10000
    );
    if (!res.ok) return { ok: false, error: classify(null, res) };
    const data = await res.json().catch(() => ({ ok: true }));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: classify(e) };
  }
}

/** POST { action: "ai", prompt, context } — proxied call to Claude. */
export async function callAiAgent(url, payload, sharedSecret) {
  if (!url) return { ok: false, error: { kind: "config", message: "No backend URL set." } };
  try {
    const res = await withTimeout(
      (signal) =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "ai", secret: sharedSecret || "", ...payload }),
          signal,
        }),
      30000 // AI can be slow
    );
    if (!res.ok) return { ok: false, error: classify(null, res) };
    const data = await res.json();
    if (data.error) return { ok: false, error: { kind: "ai", message: data.error } };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: classify(e) };
  }
}

/** POST { action: "subscribe-push", subscription } */
export async function registerPushSubscription(url, subscription, identity, sharedSecret) {
  if (!url) return { ok: false, error: { kind: "config", message: "No backend URL set." } };
  try {
    const res = await withTimeout(
      (signal) =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "subscribe-push",
            secret: sharedSecret || "",
            subscription,
            identity,
          }),
          signal,
        })
    );
    if (!res.ok) return { ok: false, error: classify(null, res) };
    return { ok: true, data: await res.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, error: classify(e) };
  }
}

/** Helper: build a webcal://  URL the user can tap to subscribe. */
export function webcalUrl(backendUrl, sharedSecret) {
  if (!backendUrl) return "";
  try {
    const u = new URL(backendUrl);
    u.searchParams.set("action", "ics");
    if (sharedSecret) u.searchParams.set("secret", sharedSecret);
    return "webcal://" + u.host + u.pathname + u.search;
  } catch {
    return "";
  }
}

/** Pretty-printed debug blob the user can copy into a bug report. */
export function formatDebugInfo(error, url) {
  return JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      url: url ? url.replace(/\/s\/[^/]+\//, "/s/REDACTED/") : null,
      error,
      ua: typeof navigator !== "undefined" ? navigator.userAgent : "n/a",
    },
    null,
    2
  );
}
