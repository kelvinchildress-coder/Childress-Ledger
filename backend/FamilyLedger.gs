/**
 * The Family Ledger — Apps Script backend
 * =========================================
 *
 * Paste this whole file into your Google Apps Script project, bound to
 * your Family Ledger Google Sheet (Extensions → Apps Script).
 *
 * Required Script Properties (Project Settings → Script Properties):
 *   ANTHROPIC_API_KEY   (optional) — enables ?action=ai for AI features
 *   SHARED_SECRET       (optional) — if set, all requests must include &secret=...
 *   PUSH_RELAY_URL      (optional) — your web-push relay (Cloudflare Worker etc.)
 *   PUSH_RELAY_TOKEN    (optional) — bearer token your relay expects
 *
 * One-time setup (run once from the Apps Script editor):
 *   1. Run setupAll()  — creates the Tasks / Settings / PushSubs sheets and installs triggers.
 *   2. Click Deploy → New deployment → Web app:
 *        Execute as: me
 *        Who has access: Anyone   (NOT "Anyone with Google account")
 *      Copy the /exec URL into the PWA Settings page.
 * 3. Enable Google Tasks API (for Keep/Tasks integration):
 *    In Apps Script editor → Services (+) button → find "Tasks API" → Add.
 *    Without this step, the google-import action won't read Google Tasks.
 */

/* =========================================================================
 *  CONFIG
 * ========================================================================= */

const SHEET_TASKS    = "Tasks";
const SHEET_SETTINGS = "Settings";
const SHEET_PUSH     = "PushSubs";

const TASK_HEADERS = [
  "id","title","details","category","assignedTo","frequency","priority",
  "deadline","lastCompleted","completionHistory","completionLog",
  "snoozedUntil","createdAt","lastModified",
];

const ANTHROPIC_MODEL = "claude-sonnet-4-5";

/* =========================================================================
 *  ENTRY POINTS — doGet / doPost
 * ========================================================================= */

function doGet(e) {
  const action = (e.parameter.action || "load").toLowerCase();
  if (!checkSecret_(e)) return jsonOut_({ error: "Unauthorized" });

  try {
    if (action === "ping") return jsonOut_({ ok: true, time: new Date().toISOString() });
    if (action === "load") return jsonOut_(loadAll_());
    if (action === "ics")  return icsOut_(buildIcs_());
    if (action === "google-import") return jsonOut_(googleImport_(e));
    return jsonOut_({ error: "Unknown action: " + action });
  } catch (err) {
    return jsonOut_({ error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || "{}"); } catch (parseErr) { /* ignored */ }
  const action = (body.action || "").toLowerCase();
  if (!checkSecretValue_(body.secret)) return jsonOut_({ error: "Unauthorized" });

  try {
    if (action === "save")            return jsonOut_(saveAll_(body.data || {}));
    if (action === "ai")              return jsonOut_(aiProxy_(body));
    if (action === "subscribe-push")  return jsonOut_(registerSub_(body));
    if (action === "google-search") return jsonOut_(googleSearch_(body));
    return jsonOut_({ error: "Unknown action: " + action });
  } catch (err) {
    return jsonOut_({ error: String(err && err.message || err) });
  }
}

/* =========================================================================
 *  AUTH
 * ========================================================================= */

function checkSecret_(e) {
  const required = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET");
  if (!required) return true;
  return e.parameter && e.parameter.secret === required;
}
function checkSecretValue_(provided) {
  const required = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET");
  if (!required) return true;
  return provided === required;
}

/* =========================================================================
 *  RESPONSE HELPERS
 * ========================================================================= */

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function icsOut_(text) {
  return ContentService.createTextOutput(text)
    .setMimeType(ContentService.MimeType.ICAL);
}

/* =========================================================================
 *  LOAD / SAVE
 * ========================================================================= */

function ensureSheets_() {
  const ss = SpreadsheetApp.getActive();
  let tasks = ss.getSheetByName(SHEET_TASKS);
  if (!tasks) {
    tasks = ss.insertSheet(SHEET_TASKS);
    tasks.getRange(1,1,1,TASK_HEADERS.length).setValues([TASK_HEADERS]).setFontWeight("bold");
    tasks.setFrozenRows(1);
  }
  let settings = ss.getSheetByName(SHEET_SETTINGS);
  if (!settings) {
    settings = ss.insertSheet(SHEET_SETTINGS);
    settings.getRange(1,1,1,2).setValues([["key","value"]]).setFontWeight("bold");
    settings.setFrozenRows(1);
    settings.getRange(2,1,5,2).setValues([
      ["parentNames",   "Parent 1,Parent 2"],
      ["kidNames",      "Kid 1"],
      ["parentEmails",  ""],
      ["dailyDigestAt", "20:00"],
      ["weeklyEmailAt", "07:00"],
    ]);
  }
  let push = ss.getSheetByName(SHEET_PUSH);
  if (!push) {
    push = ss.insertSheet(SHEET_PUSH);
    push.getRange(1,1,1,4).setValues([["endpoint","subscription_json","identity_name","registered_at"]]).setFontWeight("bold");
    push.setFrozenRows(1);
  }
  return { tasks, settings, push };
}

function loadAll_() {
  const { tasks } = ensureSheets_();
  const last = tasks.getLastRow();
  if (last < 2) return { tasks: [], lastModified: null };
  const data = tasks.getRange(2, 1, last - 1, TASK_HEADERS.length).getValues();
  let maxModified = 0;
  const out = data.map(row => {
    const obj = {};
    TASK_HEADERS.forEach((h, i) => obj[h] = row[i]);
    obj.completionHistory = parseJsonField_(obj.completionHistory, []);
    obj.completionLog     = parseJsonField_(obj.completionLog, []);
    obj.lastCompleted     = obj.lastCompleted || null;
    obj.snoozedUntil      = obj.snoozedUntil || null;
    obj.deadline          = obj.deadline || null;
    obj.createdAt         = Number(obj.createdAt) || 0;
    obj.lastModified      = Number(obj.lastModified) || obj.createdAt || 0;
    if (obj.lastModified > maxModified) maxModified = obj.lastModified;
    return obj;
  }).filter(t => t.id);
  // Also surface the household roster so the PWA can sync names/emails
  // across all devices from a single source of truth (the Sheet's Settings tab).
  const householdSettings = getSettings_();
  return {
    tasks: out,
    lastModified: maxModified,
    settings: {
      parentNames:  householdSettings.parentNames  || [],
      kidNames:     householdSettings.kidNames     || [],
      parentEmails: householdSettings.parentEmails || [],
    },
  };
}

function saveAll_(data) {
  const { tasks } = ensureSheets_();
  const arr = (data.tasks || []).filter(t => t && t.id);
  // Replace the contents wholesale — last-write-wins per onboarding doc.
  tasks.clear();
  tasks.getRange(1,1,1,TASK_HEADERS.length).setValues([TASK_HEADERS]).setFontWeight("bold");
  if (arr.length > 0) {
    const rows = arr.map(t => TASK_HEADERS.map(h => {
      const v = t[h];
      if (h === "completionHistory" || h === "completionLog") return JSON.stringify(v || []);
      return v == null ? "" : v;
    }));
    tasks.getRange(2,1,rows.length,TASK_HEADERS.length).setValues(rows);
  }
  tasks.setFrozenRows(1);
  return { ok: true, savedCount: arr.length };
}

function parseJsonField_(v, fallback) {
  if (!v) return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

/* =========================================================================
 *  SETTINGS HELPERS
 * ========================================================================= */

function getSettings_() {
  const { settings } = ensureSheets_();
  const last = settings.getLastRow();
  const out = {};
  if (last < 2) return out;
  const rows = settings.getRange(2, 1, last - 1, 2).getValues();
  rows.forEach(function (kv) { if (kv[0]) out[kv[0]] = kv[1]; });
  if (out.parentNames)  out.parentNames  = String(out.parentNames).split(",").map(s => s.trim()).filter(Boolean);
  if (out.kidNames)     out.kidNames     = String(out.kidNames).split(",").map(s => s.trim()).filter(Boolean);
  if (out.parentEmails) out.parentEmails = String(out.parentEmails).split(",").map(s => s.trim()).filter(Boolean);
  return out;
}

/* =========================================================================
 *  WEEKLY EMAIL  (trigger: Sunday 7am)
 * ========================================================================= */

function sendWeeklyEmail() {
  const loaded = loadAll_();
  const tasks = loaded.tasks;
  const settings = getSettings_();
  const to = (settings.parentEmails || []).join(",");
  if (!to) { Logger.log("No parentEmails set in Settings; skipping."); return; }

  const week = currentWeekRange_();
  const due = tasks.filter(function (t) { return isDueThisWeek_(t, week); });
  const subject = "The Week of " + Utilities.formatDate(week.start, Session.getScriptTimeZone(), "MMMM d") +
                  " — " + due.length + " items on the ledger";

  const text = composeWeeklyEmailText_(due, settings);
  const html = composeWeeklyEmailHtml_(due, settings, week);

  MailApp.sendEmail({ to: to, subject: subject, body: text, htmlBody: html, name: "The Family Ledger" });

  // Also push a notification (if relay configured + subs exist)
  sendPushToAll_({
    title: "Sunday plays are ready",
    body:  due.length + " item" + (due.length === 1 ? "" : "s") + " on the ledger this week.",
    url:   "/?view=dashboard",
    tag:   "weekly",
  });
}

function composeWeeklyEmailText_(due, settings) {
  const lines = [];
  lines.push("Good Sunday morning, " + (settings.parentNames || ["Family"]).join(" & ") + ".");
  lines.push("");
  lines.push("Here's what's on the ledger this week (" + due.length + " items):");
  lines.push("");
  groupByCategory_(due).forEach(function (g) {
    lines.push("## " + String(g.category).toUpperCase());
    g.items.forEach(function (t) {
      const meta = [t.assignedTo, t.frequency].filter(Boolean).join(" · ");
      const dl = t.deadline ? " · due " + formatDate_(t.deadline) : "";
      const prio = (t.priority === "high") ? " · PRIORITY" : "";
      lines.push("• " + t.title + " (" + meta + dl + ")" + prio);
      if (t.details) lines.push("    " + t.details);
    });
    lines.push("");
  });
  lines.push("---");
  lines.push("Reply to this email to update the ledger. Commands (one per line):");
  lines.push("  ADD: Schedule dentist · Kids Activities · monthly · Parent 2");
  lines.push("  DONE: Pay mortgage");
  lines.push("  SNOOZE: HVAC filter · until 2026-06-01");
  lines.push("  EDIT: Family meeting · frequency · biweekly");
  lines.push("  DELETE: Old task name");
  return lines.join("\n");
}

function composeWeeklyEmailHtml_(due, settings, week) {
  const sections = groupByCategory_(due).map(function (g) {
    const lis = g.items.map(function (t) {
      const dl = t.deadline ? ' <span style="color:#8A8579">· due ' + formatDate_(t.deadline) + '</span>' : "";
      const prio = (t.priority === "high") ? ' <span style="color:#C9603C;font-weight:600">PRIORITY</span>' : "";
      const details = t.details ? '<div style="font-size:13px;color:#6B6B6B;margin-top:2px">' + escapeHtml_(t.details) + '</div>' : "";
      return '<li style="margin:8px 0"><strong>' + escapeHtml_(t.title) + '</strong> ' +
        '<span style="color:#8A8579">(' + escapeHtml_(t.assignedTo) + ' · ' + escapeHtml_(t.frequency) + ')</span>' +
        dl + prio + details + '</li>';
    }).join("");
    return '<h3 style="font-family:Georgia,serif;color:#1B2C3A;margin:24px 0 8px;border-bottom:1px solid #E5DFD3;padding-bottom:6px">' +
      escapeHtml_(g.category) + '</h3><ul style="padding-left:20px;margin:0">' + lis + '</ul>';
  }).join("");

  return '<div style="font-family:Helvetica,Arial,sans-serif;color:#1B2C3A;background:#FAF7F2;padding:24px;max-width:640px">' +
    '<div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#8A8579">The Family Ledger</div>' +
    '<h1 style="font-family:Georgia,serif;font-weight:500;margin:6px 0 18px">Week of ' +
    Utilities.formatDate(week.start, Session.getScriptTimeZone(), "MMMM d") + '</h1>' +
    '<p>Good Sunday morning, ' + escapeHtml_((settings.parentNames || ["Family"]).join(" & ")) + '. ' +
    'Here\'s what\'s on the ledger this week.</p>' + sections +
    '<hr style="border:none;border-top:1px solid #E5DFD3;margin:24px 0">' +
    '<p style="font-size:12px;color:#8A8579">Reply with <code>ADD:</code> / <code>DONE:</code> / <code>SNOOZE:</code> / <code>EDIT:</code> / <code>DELETE:</code> commands to update the ledger.</p>' +
    '</div>';
}

function groupByCategory_(tasks) {
  const map = {};
  tasks.forEach(function (t) {
    const k = t.category || "other";
    if (!map[k]) map[k] = [];
    map[k].push(t);
  });
  return Object.keys(map).map(function (k) { return { category: k, items: map[k] }; });
}

function formatDate_(iso) {
  if (!iso) return "";
  const d = (iso instanceof Date) ? iso : new Date(iso);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "MMM d");
}

function currentWeekRange_() {
  const now = new Date();
  const start = new Date(now); start.setHours(0,0,0,0); start.setDate(now.getDate() - now.getDay());
  const end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23,59,59,999);
  return { start: start, end: end };
}

function isDueThisWeek_(t, week) {
  if (t.snoozedUntil && new Date(t.snoozedUntil) > new Date()) return false;
  const FREQ_DAYS = { daily:1, weekly:7, biweekly:14, monthly:30, quarterly:91, annual:365 };
  if (t.frequency === "once") {
    if (!t.deadline) return true;
    return new Date(t.deadline) <= week.end;
  }
  if (t.frequency === "daily" || t.frequency === "weekly") return true;
  if (!t.lastCompleted) return true;
  const last = new Date(t.lastCompleted);
  const nextDue = new Date(last.getTime() + (FREQ_DAYS[t.frequency] || 7) * 86400000);
  return nextDue <= week.end;
}

/* =========================================================================
 *  DAILY EVENING DIGEST  (trigger: 8pm)
 * ========================================================================= */

function sendDailyDigest() {
  const loaded = loadAll_();
  const tasks = loaded.tasks;
  const week = currentWeekRange_();
  const due = tasks.filter(function (t) { return isDueThisWeek_(t, week); });
  const todayIso = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const doneToday = due.filter(function (t) { return (t.completionHistory || []).indexOf(todayIso) >= 0; }).length;
  const openCount = due.length - doneToday;
  if (due.length === 0) return;

  sendPushToAll_({
    title: doneToday === due.length ? "All clear for today" : doneToday + " of " + due.length + " done today",
    body:  openCount === 0 ? "Nice — no open items left this week." : openCount + " still open this week.",
    url:   "/?view=dashboard",
    tag:   "daily-digest",
  });
}

/* =========================================================================
 *  EMAIL REPLY PARSER  (trigger: every 10 min)
 *
 *  Looks for replies to the weekly email and applies ADD/DONE/SNOOZE/EDIT/DELETE
 *  commands. Marks processed threads with a label so we don't re-run them.
 * ========================================================================= */

const REPLY_LABEL = "Ledger-Processed";

function processReplies() {
  const labelProcessed = GmailApp.getUserLabelByName(REPLY_LABEL) || GmailApp.createLabel(REPLY_LABEL);
  const threads = GmailApp.search('subject:"The Week of" newer_than:7d -label:' + REPLY_LABEL, 0, 25);
  if (threads.length === 0) return;

  const settings = getSettings_();
  const senders = (settings.parentEmails || []).map(function (s) { return String(s).toLowerCase(); });
  const loaded = loadAll_();
  const tasks = loaded.tasks;

  let dirty = false;
  threads.forEach(function (thread) {
    const msgs = thread.getMessages();
    msgs.forEach(function (msg) {
      const from = String(msg.getFrom()).toLowerCase();
      const allowed = senders.some(function (e) { return from.indexOf(e) >= 0; });
      if (!allowed) return;
      const body = msg.getPlainBody();
      if (applyReplyCommands_(body, tasks)) dirty = true;
    });
    thread.addLabel(labelProcessed);
  });

  if (dirty) saveAll_({ tasks: tasks });
}

function applyReplyCommands_(body, tasks) {
  const lines = body.split(/\r?\n/);
  let changed = false;
  const now = Date.now();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

  lines.forEach(function (raw) {
    const line = raw.trim();
    if (!line) return;

    if (/^ADD\s*:/i.test(line)) {
      const rest = line.replace(/^ADD\s*:/i, "").trim();
      const parts = rest.split("·").map(function (s) { return s.trim(); });
      const title = parts[0]; const category = parts[1]; const frequency = parts[2]; const assignedTo = parts[3];
      if (!title) return;
      tasks.push({
        id: "task_" + now + "_" + Math.random().toString(36).slice(2,7),
        title: title, details: "",
        category: category || "other",
        assignedTo: assignedTo || "Anyone",
        frequency: frequency || "weekly",
        priority: "medium",
        deadline: null, lastCompleted: null,
        completionHistory: [], completionLog: [],
        snoozedUntil: null, createdAt: now, lastModified: now,
      });
      changed = true;
    }

    if (/^DONE\s*:/i.test(line)) {
      const title = line.replace(/^DONE\s*:/i, "").trim();
      const t = findTask_(tasks, title);
      if (t) {
        t.completionHistory = t.completionHistory || [];
        t.completionLog = t.completionLog || [];
        if (t.completionHistory.indexOf(today) < 0) {
          t.completionHistory.push(today); t.completionHistory.sort();
          t.completionLog.push({ date: today, by: "Email" });
          t.lastCompleted = today;
          t.lastModified = now;
          changed = true;
        }
      }
    }

    if (/^SNOOZE\s*:/i.test(line)) {
      const rest = line.replace(/^SNOOZE\s*:/i, "").trim();
      const m = rest.match(/^(.+?)\s*·\s*until\s+(\d{4}-\d{2}-\d{2})/i);
      if (m) {
        const t = findTask_(tasks, m[1].trim());
        if (t) { t.snoozedUntil = m[2]; t.lastModified = now; changed = true; }
      }
    }

    if (/^EDIT\s*:/i.test(line)) {
      const rest = line.replace(/^EDIT\s*:/i, "").trim();
      const parts = rest.split("·").map(function (s) { return s.trim(); });
      if (parts.length >= 3) {
        const t = findTask_(tasks, parts[0]);
        if (t && Object.prototype.hasOwnProperty.call(t, parts[1])) {
          t[parts[1]] = parts[2];
          t.lastModified = now;
          changed = true;
        }
      }
    }

    if (/^DELETE\s*:/i.test(line)) {
      const title = line.replace(/^DELETE\s*:/i, "").trim();
      const idx = tasks.findIndex(function (t) { return fuzzyEq_(t.title, title); });
      if (idx >= 0) { tasks.splice(idx, 1); changed = true; }
    }
  });

  return changed;
}

function findTask_(tasks, title) {
  for (let i = 0; i < tasks.length; i++) if (fuzzyEq_(tasks[i].title, title)) return tasks[i];
  return null;
}
function fuzzyEq_(a, b) {
  return String(a || "").toLowerCase().trim() === String(b || "").toLowerCase().trim();
}

/* =========================================================================
 *  AI PROXY  (Apps Script → Anthropic API)
 * ========================================================================= */

function aiProxy_(body) {
  const key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!key) return { error: "ANTHROPIC_API_KEY not set in Script Properties." };

  const rate = checkRateLimit_("ai", 60, 60); // 60 calls per hour
  if (!rate.ok) return { error: "Rate limited. Try again in " + rate.retryIn + "s." };

  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: Math.min(body.max_tokens || 600, 1500),
    system: body.system || "You are a helpful family-operations assistant.",
    messages: [{ role: "user", content: body.prompt || "" }],
  };

  const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) return { error: "Anthropic API " + code + ": " + text.slice(0, 200) };
  const json = JSON.parse(text);
  const out = (json.content || []).filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; }).join("\n").trim();
  return { text: out, model: json.model, usage: json.usage };
}

function checkRateLimit_(bucket, max, windowMin) {
  const cache = CacheService.getScriptCache();
  const key = "rl:" + bucket;
  const now = Date.now();
  const raw = cache.get(key);
  const arr = raw ? JSON.parse(raw) : [];
  const recent = arr.filter(function (ts) { return now - ts < windowMin * 60000; });
  if (recent.length >= max) {
    const earliest = recent[0];
    return { ok: false, retryIn: Math.ceil((windowMin * 60000 - (now - earliest)) / 1000) };
  }
  recent.push(now);
  cache.put(key, JSON.stringify(recent), windowMin * 60);
  return { ok: true };
}

/* =========================================================================
 *  ICS / WEBCAL feed
 * ========================================================================= */

function buildIcs_() {
  const loaded = loadAll_();
  const tasks = loaded.tasks;
  const FREQ_MAP = {
    daily: "DAILY", weekly: "WEEKLY", biweekly: "WEEKLY;INTERVAL=2",
    monthly: "MONTHLY", quarterly: "MONTHLY;INTERVAL=3", annual: "YEARLY",
  };
  const tz = Session.getScriptTimeZone();
  const fmt = function (d) { return Utilities.formatDate(d, "UTC", "yyyyMMdd'T'HHmmss'Z'"); };
  const esc = function (s) { return String(s || "").replace(/[\\,;]/g, "\\$&").replace(/\n/g, "\\n"); };

  const lines = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//The Family Ledger//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH","X-WR-CALNAME:The Family Ledger","X-WR-TIMEZONE:" + tz];
  tasks.forEach(function (t) {
    if (t.frequency === "once" && !t.deadline) return;
    const baseDate = t.deadline ? new Date(t.deadline) : currentWeekRange_().end;
    const start = new Date(baseDate); start.setHours(9,0,0,0);
    const end = new Date(start); end.setMinutes(30);
    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + t.id + "@family-ledger");
    lines.push("DTSTAMP:" + fmt(new Date()));
    lines.push("DTSTART:" + fmt(start));
    lines.push("DTEND:" + fmt(end));
    lines.push("SUMMARY:" + esc(t.title));
    lines.push("DESCRIPTION:" + esc([t.details, "Assigned: " + t.assignedTo, "Priority: " + t.priority].filter(Boolean).join("\n")));
    if (t.frequency !== "once" && FREQ_MAP[t.frequency]) lines.push("RRULE:FREQ=" + FREQ_MAP[t.frequency]);
    lines.push("BEGIN:VALARM"); lines.push("TRIGGER:-PT60M"); lines.push("ACTION:DISPLAY"); lines.push("DESCRIPTION:" + esc(t.title)); lines.push("END:VALARM");
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

/* =========================================================================
 *  PUSH SUBSCRIPTION REGISTRATION + DELIVERY
 *
 *  We store subscriptions in a sheet. Actual web-push delivery requires
 *  a tiny relay (Cloudflare Worker is easiest) because Apps Script can't
 *  do the EC crypto needed for VAPID-signed pushes itself.
 *
 *  Set PUSH_RELAY_URL to your relay; it should accept POST body:
 *    { subscriptions: [...], payload: {...} }
 * ========================================================================= */

function registerSub_(body) {
  const sub = body.subscription;
  if (!sub || !sub.endpoint) return { error: "Missing subscription." };
  const { push } = ensureSheets_();
  // Dedup by endpoint
  const last = push.getLastRow();
  let row = -1;
  if (last >= 2) {
    const endpoints = push.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return r[0]; });
    row = endpoints.findIndex(function (e) { return e === sub.endpoint; });
  }
  const rowData = [sub.endpoint, JSON.stringify(sub), (body.identity && body.identity.name) || "", new Date().toISOString()];
  if (row >= 0) push.getRange(row + 2, 1, 1, 4).setValues([rowData]);
  else          push.appendRow(rowData);
  return { ok: true };
}

function sendPushToAll_(payload) {
  const relayUrl   = PropertiesService.getScriptProperties().getProperty("PUSH_RELAY_URL");
  const relayToken = PropertiesService.getScriptProperties().getProperty("PUSH_RELAY_TOKEN") || "";
  if (!relayUrl) { Logger.log("PUSH_RELAY_URL not set; skipping push."); return; }

  const { push } = ensureSheets_();
  const last = push.getLastRow();
  if (last < 2) return;
  const rows = push.getRange(2, 1, last - 1, 4).getValues();
  const subs = rows.map(function (r) { try { return JSON.parse(r[1]); } catch (e) { return null; } }).filter(Boolean);
  if (subs.length === 0) return;

  const res = UrlFetchApp.fetch(relayUrl, {
    method: "post",
    contentType: "application/json",
    headers: relayToken ? { Authorization: "Bearer " + relayToken } : {},
    payload: JSON.stringify({ subscriptions: subs, payload: payload }),
    muteHttpExceptions: true,
  });
  Logger.log("Push relay response: " + res.getResponseCode());
}

/* =========================================================================
 *  ESCAPE HELPER
 * ========================================================================= */

function escapeHtml_(s) {
  return String(s || "").replace(/[&<>"']/g, function (c) {
    return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c];
  });
}

/* =========================================================================
 *  ONE-TIME SETUP — run these from the Apps Script editor
 * ========================================================================= */

function setupAll() {
  ensureSheets_();
  setupTriggers_();
  try {
    Browser.msgBox("Family Ledger setup complete. Now deploy: Deploy → New deployment → Web app → Anyone.");
  } catch (e) {
    Logger.log("Setup complete. Now Deploy → New deployment → Web app → Anyone.");
  }
}

function setupTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger("sendWeeklyEmail").timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(7).create();

  ScriptApp.newTrigger("processReplies").timeBased()
    .everyMinutes(10).create();

  ScriptApp.newTrigger("sendDailyDigest").timeBased()
    .everyDays(1).atHour(20).create();
}


/* =========================================================================
 * GOOGLE SERVICES INTEGRATION (Gmail, Calendar, Keep)
 * =========================================================================
 *
 * These run inside Apps Script as the script owner, so they have access
 * to the owner's Gmail, Calendar, and Tasks (Keep tasks sync via Tasks API).
 *
 * doGet: action=google-import  — returns recent email subjects, calendar
 *   events, and Keep/Tasks items so the PWA can suggest tasks.
 * doPost: action=google-search — searches with a query string for more
 *   targeted results.
 */

/**
 * GET ?action=google-import
 * Returns recent Gmail threads (subjects + snippets), upcoming calendar events,
 * and Google Tasks (Keep-synced lists) as raw data for task suggestions.
 */
function googleImport_(e) {
  const maxEmails = parseInt(e.parameter.maxEmails || "10", 10);
  const maxEvents = parseInt(e.parameter.maxEvents || "15", 10);
  const maxTasks  = parseInt(e.parameter.maxTasks  || "20", 10);
  const daysAhead = parseInt(e.parameter.daysAhead || "14", 10);

  const results = { emails: [], events: [], tasks: [], errors: [] };

  // ---- Gmail: recent unread/important threads ----
  try {
    const threads = GmailApp.search("is:unread OR is:important", 0, maxEmails);
    threads.forEach(function(thread) {
      const msg = thread.getMessages()[0];
      results.emails.push({
        subject: msg.getSubject(),
        from: msg.getFrom(),
        snippet: thread.getFirstMessageSubject(),
        date: msg.getDate().toISOString(),
        id: thread.getId(),
      });
    });
  } catch(err) {
    results.errors.push({ service: "gmail", error: String(err.message || err) });
  }

  // ---- Google Calendar: upcoming events ----
  try {
    const now = new Date();
    const future = new Date(now.getTime() + daysAhead * 86400000);
    const calendars = CalendarApp.getAllCalendars();
    calendars.slice(0, 5).forEach(function(cal) {
      if (cal.isHidden()) return;
      const events = cal.getEvents(now, future);
      events.slice(0, Math.floor(maxEvents / Math.max(calendars.length, 1)) + 2).forEach(function(ev) {
        results.events.push({
          title: ev.getTitle(),
          start: ev.getStartTime().toISOString(),
          end: ev.getEndTime().toISOString(),
          calendar: cal.getName(),
          description: (ev.getDescription() || "").substring(0, 200),
          id: ev.getId(),
          isAllDay: ev.isAllDayEvent(),
        });
      });
    });
    // Sort and trim
    results.events.sort(function(a, b) { return a.start < b.start ? -1 : 1; });
    results.events = results.events.slice(0, maxEvents);
  } catch(err) {
    results.errors.push({ service: "calendar", error: String(err.message || err) });
  }

  // ---- Google Tasks (syncs with Keep checklists) ----
  try {
    const taskLists = Tasks.Tasklists.list({ maxResults: 10 });
    if (taskLists.items) {
      taskLists.items.forEach(function(list) {
        const taskItems = Tasks.Tasks.list(list.id, {
          maxResults: Math.ceil(maxTasks / Math.max(taskLists.items.length, 1)),
          showCompleted: false,
          showHidden: false,
        });
        if (taskItems.items) {
          taskItems.items.forEach(function(task) {
            results.tasks.push({
              title: task.title,
              notes: (task.notes || "").substring(0, 300),
              due: task.due || null,
              status: task.status,
              list: list.title,
              id: task.id,
            });
          });
        }
      });
    }
    results.tasks = results.tasks.slice(0, maxTasks);
  } catch(err) {
    results.errors.push({ service: "tasks", error: String(err.message || err) });
  }

  return results;
}

/**
 * POST { action: "google-search", query, services }
 * Targeted search across Gmail / Calendar / Tasks for a specific query.
 * services: array like ["gmail","calendar","tasks"] — defaults to all.
 */
function googleSearch_(body) {
  const query   = (body.query || "").trim();
  const services = body.services || ["gmail", "calendar", "tasks"];
  if (!query) return { error: "query is required" };

  const results = { emails: [], events: [], tasks: [], query: query, errors: [] };

  // ---- Gmail search ----
  if (services.indexOf("gmail") >= 0) {
    try {
      const threads = GmailApp.search(query, 0, 10);
      threads.forEach(function(thread) {
        const msg = thread.getMessages()[0];
        results.emails.push({
          subject: msg.getSubject(),
          from: msg.getFrom(),
          snippet: msg.getPlainBody().substring(0, 300),
          date: msg.getDate().toISOString(),
          id: thread.getId(),
        });
      });
    } catch(err) {
      results.errors.push({ service: "gmail", error: String(err.message || err) });
    }
  }

  // ---- Calendar search ----
  if (services.indexOf("calendar") >= 0) {
    try {
      const now = new Date();
      const future = new Date(now.getTime() + 60 * 86400000); // 60 days
      const past   = new Date(now.getTime() - 30 * 86400000); // 30 days back
      CalendarApp.getAllCalendars().slice(0, 5).forEach(function(cal) {
        if (cal.isHidden()) return;
        cal.getEvents(past, future).forEach(function(ev) {
          if (ev.getTitle().toLowerCase().indexOf(query.toLowerCase()) >= 0 ||
              (ev.getDescription() || "").toLowerCase().indexOf(query.toLowerCase()) >= 0) {
            results.events.push({
              title: ev.getTitle(),
              start: ev.getStartTime().toISOString(),
              end: ev.getEndTime().toISOString(),
              calendar: cal.getName(),
              id: ev.getId(),
            });
          }
        });
      });
      results.events = results.events.slice(0, 10);
    } catch(err) {
      results.errors.push({ service: "calendar", error: String(err.message || err) });
    }
  }

  // ---- Tasks search ----
  if (services.indexOf("tasks") >= 0) {
    try {
      const taskLists = Tasks.Tasklists.list({ maxResults: 10 });
      if (taskLists.items) {
        taskLists.items.forEach(function(list) {
          const taskItems = Tasks.Tasks.list(list.id, {
            maxResults: 50,
            showCompleted: false,
            showHidden: false,
          });
          if (taskItems.items) {
            taskItems.items.forEach(function(task) {
              if (task.title.toLowerCase().indexOf(query.toLowerCase()) >= 0 ||
                  (task.notes || "").toLowerCase().indexOf(query.toLowerCase()) >= 0) {
                results.tasks.push({
                  title: task.title,
                  notes: (task.notes || "").substring(0, 300),
                  due: task.due || null,
                  list: list.title,
                  id: task.id,
                });
              }
            });
          }
        });
      }
    } catch(err) {
      results.errors.push({ service: "tasks", error: String(err.message || err) });
    }
  }

  return results;
}
