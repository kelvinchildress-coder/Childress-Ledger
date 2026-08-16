/* =====================================================================
 *  LedgerSyncEndpoints.gs  —  ADD THIS AS A NEW FILE
 * ---------------------------------------------------------------------
 *  Reconciles the deployed frontend with this backend. Adds handlers for:
 *    - ai                (Gemini-backed AI; digest, brainstorm, categorize, photo)
 *    - get/save-reminders (birthdays/anniversaries, synced)
 *    - subscribe-push     (web-push registration)
 *    - google-import      (Gmail + Calendar context)
 *    - google-search      (query Gmail + Calendar)
 *    - ics                (calendar subscription feed)
 *    - get/save-notes, get/save-when-possible, get/save-subs
 *
 *  Requires (already used elsewhere in your project):
 *    Script Property GEMINI_KEY  — for the AI features.
 *    Script Property PUSH_RELAY_URL (optional) — for real push delivery.
 *
 *  In the Apps Script editor: + (Files) → Script → name it
 *  "LedgerSyncEndpoints" → paste this in. Then replace doGet/doPost with
 *  the versions in REPLACE_doGet_doPost.gs and deploy a New version.
 * ===================================================================== */


/* ---- Simple JSON key-value store (Reminders / Notes / When-Possible / Subs) ---- */
function getKV_(key, field) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('fl_' + key);
    var arr = raw ? JSON.parse(raw) : [];
    var out = {};
    out[field] = (arr instanceof Array) ? arr : [];
    return out;
  } catch (err) {
    var o = { error: String(err) };
    o[field] = [];
    return o;
  }
}
function setKV_(key, value) {
  try {
    var arr = (value instanceof Array) ? value : [];
    PropertiesService.getScriptProperties().setProperty('fl_' + key, JSON.stringify(arr));
    return { ok: true, count: arr.length };
  } catch (err) {
    return { error: String(err) };
  }
}


/* ---- AI proxy (Gemini) — matches what ai.js / callAiAgent expect ---- */
/* Frontend posts { action:'ai', system, prompt, max_tokens, imageBase64?, imageMediaType? }
   and reads back { text }.  Errors come back as { error }. */
function handleAi_(body) {
  try {
    var key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
    if (!key) return { error: 'GEMINI_KEY not set in Script Properties' };

    var system = body.system || '';
    var prompt = body.prompt || '';
    var maxTokens = Number(body.max_tokens) || 1200;

    var parts = [];
    if (system) parts.push({ text: 'SYSTEM INSTRUCTIONS:\n' + system + '\n\nReturn ONLY what was asked. If JSON was requested, output raw JSON with no markdown fences.' });
    if (body.imageBase64) {
      parts.push({ inline_data: { mime_type: body.imageMediaType || 'image/jpeg', data: body.imageBase64 } });
    }
    parts.push({ text: prompt });

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + key;
    var payload = JSON.stringify({
      contents: [{ role: 'user', parts: parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens }
    });
    var resp = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: payload, muteHttpExceptions: true });
    var data = JSON.parse(resp.getContentText());
    if (data.error) return { error: data.error.message || 'AI error' };
    var text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
                data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
                data.candidates[0].content.parts[0].text) || '';
    return { text: text };
  } catch (e) {
    return { error: String(e) };
  }
}


/* ---- Web-push registration ---- */
function handleSubscribePush_(body) {
  try {
    var id = (body.identity && (body.identity.id || body.identity.name)) || ('dev_' + Date.now());
    var nm = (body.identity && body.identity.name) || 'Family';
    savePushSub(id, nm, body.subscription);   // reuses your existing helper
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


/* ---- Google import: recent Gmail + upcoming Calendar (+ Tasks if enabled) ---- */
function handleGoogleImport_(e) {
  var p = (e && e.parameter) || {};
  var maxEmails = parseInt(p.maxEmails, 10) || 10;
  var maxEvents = parseInt(p.maxEvents, 10) || 15;
  var daysAhead = parseInt(p.daysAhead, 10) || 14;
  var out = { emails: [], events: [], tasks: [], errors: [] };

  try {
    GmailApp.search('in:inbox newer_than:14d', 0, maxEmails).forEach(function (th) {
      var msgs = th.getMessages();
      var msg = msgs[msgs.length - 1];
      out.emails.push({
        id: msg.getId(), subject: msg.getSubject() || '', from: msg.getFrom() || '',
        snippet: (msg.getPlainBody() || '').slice(0, 160).replace(/\s+/g, ' ').trim(),
        date: msg.getDate().toISOString()
      });
    });
  } catch (err) { out.errors.push({ service: 'gmail', message: String(err) }); }

  try {
    var now = new Date();
    var ahead = new Date(now.getTime() + daysAhead * 86400000);
    CalendarApp.getAllCalendars().forEach(function (cal) {
      cal.getEvents(now, ahead).forEach(function (ev) {
        out.events.push({
          id: ev.getId(), title: ev.getTitle(), start: ev.getStartTime().toISOString(),
          end: ev.getEndTime().toISOString(), calendar: cal.getName(),
          description: ev.getDescription() || '', isAllDay: ev.isAllDayEvent()
        });
      });
    });
    out.events.sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
    out.events = out.events.slice(0, maxEvents);
  } catch (err) { out.errors.push({ service: 'calendar', message: String(err) }); }

  // Google Tasks — only if the advanced service is enabled; otherwise skip quietly.
  try {
    if (typeof Tasks !== 'undefined' && Tasks.Tasklists) {
      (Tasks.Tasklists.list().items || []).forEach(function (tl) {
        ((Tasks.Tasks.list(tl.id, { showCompleted: false, maxResults: 20 }).items) || []).forEach(function (it) {
          out.tasks.push({ id: it.id, title: it.title || '', notes: it.notes || '', due: it.due || null, status: it.status || '', list: tl.title || '' });
        });
      });
    }
  } catch (err) { out.errors.push({ service: 'tasks', message: String(err) }); }

  return out;
}


/* ---- Google search across Gmail + Calendar ---- */
function handleGoogleSearch_(body) {
  var q = (body.query || '').trim();
  var services = body.services || ['gmail', 'calendar', 'tasks'];
  var out = { emails: [], events: [], tasks: [], errors: [] };
  if (!q) return out;

  if (services.indexOf('gmail') >= 0) {
    try {
      GmailApp.search(q, 0, 10).forEach(function (th) {
        var msgs = th.getMessages(); var msg = msgs[msgs.length - 1];
        out.emails.push({
          id: msg.getId(), subject: msg.getSubject() || '', from: msg.getFrom() || '',
          snippet: (msg.getPlainBody() || '').slice(0, 160).replace(/\s+/g, ' ').trim(),
          date: msg.getDate().toISOString()
        });
      });
    } catch (err) { out.errors.push({ service: 'gmail', message: String(err) }); }
  }

  if (services.indexOf('calendar') >= 0) {
    try {
      var now = new Date();
      var ahead = new Date(now.getTime() + 90 * 86400000);
      var ql = q.toLowerCase();
      CalendarApp.getAllCalendars().forEach(function (cal) {
        cal.getEvents(now, ahead).forEach(function (ev) {
          if ((ev.getTitle() || '').toLowerCase().indexOf(ql) >= 0) {
            out.events.push({
              id: ev.getId(), title: ev.getTitle(), start: ev.getStartTime().toISOString(),
              end: ev.getEndTime().toISOString(), calendar: cal.getName(),
              description: ev.getDescription() || '', isAllDay: ev.isAllDayEvent()
            });
          }
        });
      });
    } catch (err) { out.errors.push({ service: 'calendar', message: String(err) }); }
  }

  return out;
}


/* ---- ICS calendar feed (webcal subscription) ---- */
function buildIcsFromTasks_() {
  var tasks = (loadData().tasks) || [];
  var esc = function (s) { return String(s || '').replace(/[\\,;]/g, ' ').replace(/[\r\n]+/g, ' '); };
  var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Family Ledger//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  tasks.forEach(function (t) {
    if (!t.deadline) return;
    var d = String(t.deadline).slice(0, 10).replace(/-/g, '');
    if (!/^\d{8}$/.test(d)) return;
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + (t.id || Utilities.getUuid()) + '@family-ledger');
    lines.push('DTSTAMP:' + Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'"));
    lines.push('DTSTART;VALUE=DATE:' + d);
    lines.push('SUMMARY:' + esc(t.title || 'Task'));
    if (t.details) lines.push('DESCRIPTION:' + esc(t.details).slice(0, 200));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}


/* ---- Morning Report: per-user interests + AI-summarized brief ---- */
function getMorningConfig_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty("fl_morning_config");
    return { configs: raw ? JSON.parse(raw) : {} };
  } catch (e) { return { configs: {}, error: String(e) }; }
}
function saveMorningConfig_(body) {
  try {
    PropertiesService.getScriptProperties().setProperty("fl_morning_config", JSON.stringify(body.configs || {}));
    return { ok: true };
  } catch (e) { return { error: String(e) }; }
}

function parseRssItems_(xml, limit) {
  var items = [];
  try {
    var doc = XmlService.parse(xml);
    var channel = doc.getRootElement().getChild("channel");
    if (!channel) return items;
    var its = channel.getChildren("item");
    for (var i = 0; i < its.length && i < limit; i++) {
      items.push({ title: its[i].getChildText("title") || "", url: its[i].getChildText("link") || "" });
    }
  } catch (e) {}
  return items;
}

function handleMorningReport_(body) {
  var cfg = body.config || {};
  var name = (body.userName || "there");
  var news = (cfg.news || []).filter(Boolean).slice(0, 6);
  var research = (cfg.research || []).filter(Boolean).slice(0, 4);
  var wantBible = cfg.bible !== false;
  var custom = (cfg.custom || "").trim();

  var requests = [], meta = [];
  news.forEach(function (q) {
    requests.push({ url: "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en", muteHttpExceptions: true });
    meta.push({ type: "news", q: q });
  });
  research.forEach(function (q) {
    requests.push({ url: "https://api.semanticscholar.org/graph/v1/paper/search?query=" + encodeURIComponent(q) + "&limit=4&fields=title,abstract,url,year", muteHttpExceptions: true });
    meta.push({ type: "research", q: q });
  });
  if (wantBible) {
    requests.push({ url: "https://beta.ourmanna.com/api/v1/get/?format=json&order=daily", muteHttpExceptions: true });
    meta.push({ type: "bible" });
  }

  var responses = [];
  if (requests.length) { try { responses = UrlFetchApp.fetchAll(requests); } catch (e) { responses = []; } }

  var newsItems = {}, researchItems = {}, verse = null;
  responses.forEach(function (resp, i) {
    var m = meta[i];
    try {
      var txt = resp.getContentText();
      if (m.type === "news") {
        newsItems[m.q] = parseRssItems_(txt, 5);
      } else if (m.type === "research") {
        var data = JSON.parse(txt);
        researchItems[m.q] = (data.data || []).map(function (p) {
          return { title: p.title || "", url: p.url || "", year: p.year || "", abstract: (p.abstract || "").slice(0, 400) };
        });
      } else if (m.type === "bible") {
        var bd = JSON.parse(txt);
        verse = { text: bd.verse.details.text, reference: bd.verse.details.reference };
      }
    } catch (e) {}
  });

  var ctx = "Family member: " + name + "\nDate: " + (new Date()).toDateString() + "\n\n";
  Object.keys(newsItems).forEach(function (q) {
    if (newsItems[q].length) ctx += "NEWS about \"" + q + "\":\n" + newsItems[q].map(function (it) { return "- " + it.title; }).join("\n") + "\n\n";
  });
  Object.keys(researchItems).forEach(function (q) {
    if (researchItems[q].length) ctx += "RESEARCH on \"" + q + "\":\n" + researchItems[q].map(function (it) { return "- " + it.title + (it.year ? (" (" + it.year + ")") : "") + ": " + (it.abstract || "").slice(0, 220); }).join("\n") + "\n\n";
  });
  if (custom) ctx += "CUSTOM REQUEST from user (address using your general knowledge): " + custom + "\n\n";

  var brief = "";
  if (ctx.trim().split("\n").length > 3) {
    var sys = "You are a warm, upbeat personal morning-briefing writer for " + name + ". Using ONLY the provided items, write a concise brief organized by short section headers (News, Research, and any custom request). Give 1-2 sentence summaries per section. Never invent headlines or facts not in the input. Skip empty sections. Under 220 words. Friendly plain text, no markdown fences.";
    try {
      var ai = handleAi_({ system: sys, prompt: ctx + "\nWrite the brief now.", max_tokens: 700 });
      brief = ai.text || "";
    } catch (e) { brief = ""; }
  }

  return {
    ok: true,
    date: (new Date()).toISOString().slice(0, 10),
    greeting: "Good morning, " + name,
    brief: brief,
    verse: verse,
    news: newsItems,
    research: researchItems
  };
}
