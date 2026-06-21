/* =====================================================================
 *  ai.js - Claude AI agent assistance
 * =====================================================================
 *
 * All calls are proxied through Apps Script (action=ai). The Anthropic
 * API key lives in Apps Script Script Properties, never in the browser.
 */

import { callAiAgent } from "./sync.js";

const CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}
function getCached(key) {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.value;
  return null;
}
function setCached(key, value) {
  CACHE.set(key, { value, ts: Date.now() });
}

/**
 * Robustly extract a JSON object from model output. Tries, in order:
 *   1. A fenced ```json ... ``` block (most strict, what the prompt asks for).
 *   2. The entire text trimmed.
 *   3. The largest {...} substring (salvages "Sure! Here's the JSON: {...}").
 * Returns the parsed object, or null if nothing works.
 */
function tryParseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?s*([sS]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  try { return JSON.parse(text.trim()); } catch {}
  const first = text.indexOf("{");
  const last  = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  return null;
}

/**
 * Coerce a brainstorm AI response into a guaranteed shape. Silently drops
 * tasks with bad/missing titles, and snaps enum fields (category, frequency,
 * priority, assignedTo) to allowed values so a slightly-off model response
 * still produces usable tasks instead of a crash.
 */
function normalizeBrainstormResponse(parsed, { categories, frequencies, assignees }) {
  const empty = { reply: "I got a response but couldn't read it. Try rephrasing?", proposedTasks: [], followUp: null, done: false };
  if (!parsed || typeof parsed !== "object") return empty;

  const categoryIds  = categories.map(c => c.id);
  const frequencyIds = frequencies.map(f => f.id);
  const defaultCategory  = categoryIds[0]  || "house-care";
  const defaultFrequency = frequencyIds[0] || "weekly";
  const defaultAssignee  = assignees.includes("Family") ? "Family" : (assignees[0] || "Anyone");
  const validPriorities  = ["high", "medium", "low"];

  const rawTasks = Array.isArray(parsed.proposedTasks) ? parsed.proposedTasks : [];
  const proposedTasks = rawTasks
    .filter(t => t && typeof t === "object" && typeof t.title === "string" && t.title.trim())
    .map(t => ({
      title:      String(t.title).trim(),
      category:   categoryIds.includes(t.category)   ? t.category   : defaultCategory,
      frequency:  frequencyIds.includes(t.frequency) ? t.frequency  : defaultFrequency,
      priority:   validPriorities.includes(t.priority) ? t.priority : "medium",
      assignedTo: assignees.includes(t.assignedTo)   ? t.assignedTo : defaultAssignee,
      deadline:   typeof t.deadline === "string" && /^d{4}-d{2}-d{2}$/.test(t.deadline) ? t.deadline : null,
      details:    typeof t.details   === "string" ? t.details   : "",
      reasoning:  typeof t.reasoning === "string" ? t.reasoning : "",
    }));

  return {
    reply:    typeof parsed.reply    === "string" && parsed.reply.trim()    ? parsed.reply.trim()    : "Here's what I came up with.",
    proposedTasks,
    followUp: typeof parsed.followUp === "string" && parsed.followUp.trim() ? parsed.followUp.trim() : null,
    done:     parsed.done === true,
  };
}

/** Auto-categorise a new task from its title. */
export async function suggestTaskMetadata({ backendUrl, sharedSecret, title, knownAssignees, categories, frequencies }) {
  if (!title || title.trim().length < 3) return null;
  const cacheKey = "meta:" + hash(title);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const system =
    "You help a busy family categorise household tasks. " +
    "Given a task title, return STRICT JSON with: " +
    `{"category": one of [${categories.map((c) => `"${c.id}"`).join(",")}], ` +
    `"frequency": one of [${frequencies.map((f) => `"${f.id}"`).join(",")}], ` +
    `"priority": one of ["high","medium","low"], ` +
    `"assignedTo": one of [${knownAssignees.map((a) => `"${a}"`).join(",")}], ` +
    `"deadline": ISO date YYYY-MM-DD or null}. ` +
    "Never include explanation outside the JSON.";

  const res = await callAiAgent(backendUrl, {
    system, prompt: `Task title: "${title}"`, max_tokens: 200, purpose: "categorize",
  }, sharedSecret);
  if (!res.ok) return { error: res.error };
  const parsed = tryParseJson(res.data.text || res.data.content || "");
  if (!parsed) return { error: { kind: "parse", message: "Couldn't parse AI response." } };
  setCached(cacheKey, parsed);
  return parsed;
}

/** End-of-week retrospective: 3-bullet summary + 1 suggested change. */
export async function weeklyRetrospective({ backendUrl, sharedSecret, snapshot }) {
  const cacheKey = "retro:" + hash(JSON.stringify(snapshot).slice(0, 4000));
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const system =
    "You're a warm, concise family-operations coach. Look at this week's task data and reply with STRICT JSON: " +
    `{"wins":["..."], "drift":["..."], "suggestion":"..."}. ` +
    "wins are 1-3 positive observations. drift are 1-3 things that slipped or look at risk. " +
    "suggestion is one concrete improvement the family could try next week. Keep each item under 110 chars.";

  const res = await callAiAgent(backendUrl, {
    system,
    prompt: "This week's snapshot:\n" + JSON.stringify(snapshot, null, 2),
    max_tokens: 600, purpose: "retrospective",
  }, sharedSecret);
  if (!res.ok) return { error: res.error };
  const parsed = tryParseJson(res.data.text || res.data.content || "");
  if (!parsed) return { error: { kind: "parse", message: "Couldn't parse AI response." } };
  setCached(cacheKey, parsed);
  return parsed;
}

/** Detect tasks that look stale or out-of-rhythm. */
export async function staleTaskAdvice({ backendUrl, sharedSecret, candidates }) {
  if (!candidates?.length) return { items: [] };
  const cacheKey = "stale:" + hash(JSON.stringify(candidates));
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const system =
    "You analyse stale family tasks. Return STRICT JSON: " +
    `{"items":[{"taskId":"...","action":"delete"|"snooze"|"rephrase"|"keep","reason":"..."}]}. ` +
    "Be conservative: only suggest delete if the task hasn't been completed in 60+ days and has no streak.";
  const res = await callAiAgent(backendUrl, {
    system, prompt: JSON.stringify(candidates, null, 2), max_tokens: 800, purpose: "stale",
  }, sharedSecret);
  if (!res.ok) return { error: res.error };
  const parsed = tryParseJson(res.data.text || res.data.content || "");
  if (!parsed) return { error: { kind: "parse", message: "Couldn't parse AI response." } };
  setCached(cacheKey, parsed);
  return parsed;
}

/** Parse a natural-language deadline like "next Tuesday" -> ISO date. */
export async function parseDeadline({ backendUrl, sharedSecret, phrase, today }) {
  if (!phrase) return null;
  const cacheKey = "deadline:" + hash(phrase + ":" + today);
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const system =
    "Convert a natural-language date phrase to STRICT JSON " +
    `{"iso":"YYYY-MM-DD" | null, "label":"human-readable"}. ` +
    `Treat today as ${today}. If the phrase isn't a date, return iso:null.`;
  const res = await callAiAgent(backendUrl, {
    system, prompt: phrase, max_tokens: 80, purpose: "deadline",
  }, sharedSecret);
  if (!res.ok) return { error: res.error };
  const parsed = tryParseJson(res.data.text || res.data.content || "");
  if (!parsed) return { error: { kind: "parse", message: "Couldn't parse AI response." } };
  setCached(cacheKey, parsed);
  return parsed;
}

/**
 * Conversational brainstorm. Multi-turn chat where Claude asks follow-ups
 * and proposes batches of tasks the user can accept / edit / reject.
 *
 * Args:
 *   conversation - [{ role: "user"|"assistant", content: "..." }, ...]
 *   household    - { parentNames, kidNames, parentEmails }
 *   categories, frequencies - the enum we want Claude to choose from
 *
 * Returns:
 *   { reply, proposedTasks: [...], followUp, done } | { error }
 */
export async function brainstormTasks({ backendUrl, sharedSecret, conversation, household, categories, frequencies , googleContext}) {
  const assignees = [
    ...(household.parentNames || []),
    "Both Parents",
    ...(household.kidNames || []),
    "Anyone",
    "Family",
  ];

  let system =
    "You are a warm, practical family-operations brainstorm partner helping a household plan tasks. " +
    "Your job: through natural conversation, help the user produce a complete list of tasks for whatever they're planning. " +
    "Behaviour rules:\n" +
    "1. ASK clarifying questions before proposing tasks. Don't dump a list on the first message.\n" +
    "2. After you have enough context, propose 3-10 specific tasks in JSON.\n" +
    "3. Always include a follow-up question to surface tasks the user might be missing (e.g. 'What about X?').\n" +
    "4. Categories MUST be one of: " + categories.map(c => `"${c.id}"`).join(", ") + ".\n" +
    "5. Frequencies MUST be one of: " + frequencies.map(f => `"${f.id}"`).join(", ") + ".\n" +
    "6. Assignees MUST be one of: " + assignees.map(a => `"${a}"`).join(", ") + ".\n" +
    "7. Priorities: \"high\" only for safety/legal/financial-deadline things, \"medium\" default, \"low\" for nice-to-haves.\n\n" +
    "Output STRICT JSON only, no prose outside the JSON:\n" +
    `{
  "reply": "natural conversational response, 1-3 sentences",
  "proposedTasks": [
    {
      "title": "short imperative",
      "category": "<one of the category ids>",
      "frequency": "<one of the frequency ids>",
      "priority": "high|medium|low",
      "assignedTo": "<one of the assignees>",
      "deadline": "YYYY-MM-DD or null",
      "details": "1-2 sentence helpful detail",
      "reasoning": "1 sentence why this matters"
    }
  ],
  "followUp": "next question to ask the user, or null when the list feels complete",
  "done": false
}` +
    "\nSet done: true only when the user has explicitly confirmed they're satisfied with the list." +
    "\nOn the first message, proposedTasks should usually be empty and you ask a clarifying question.";
  if (googleContext) {
    system += "\n\n" + googleContext;
  }

  // Flatten the conversation into a single user message — Apps Script proxy
  // expects { system, prompt } not full message history.
  const transcript = conversation.map(m =>
    (m.role === "user" ? "USER: " : "ASSISTANT: ") + m.content
  ).join("\n\n");

  const res = await callAiAgent(backendUrl, {
    system,
    prompt: "Conversation so far:\n\n" + transcript + "\n\nRespond now with strict JSON only.",
    max_tokens: 1500,
    purpose: "brainstorm",
  }, sharedSecret);

  if (!res.ok) return { error: res.error };
  const raw = res.data.text || res.data.content || "";
  const parsed = tryParseJson(raw);
  if (!parsed) {
    return { error: { kind: "parse", message: "Couldn't parse AI response. Try rephrasing.", rawSnippet: raw.slice(0, 200) } };
  }
  return normalizeBrainstormResponse(parsed, { categories, frequencies, assignees });
}


/**
 * analyzePhoto — sends an image (base64) to Claude vision for plant/tree/object
 * identification and returns care tips or relevant task suggestions.
 *
 * @param {object} opts
 * @param {string} opts.backendUrl
 * @param {string} opts.sharedSecret
 * @param {string} opts.imageBase64    — base64-encoded image data (no data: prefix)
 * @param {string} [opts.imageMediaType] — e.g. "image/jpeg" or "image/png"
 * @param {string} [opts.context]      — optional text hint from user
 * @returns {Promise<{title, details, category, ok, raw}>}
 */
export async function analyzePhoto({ backendUrl, sharedSecret, imageBase64, imageMediaType = "image/jpeg", context = "" }) {
  const prompt = [
    "Please analyze this image and identify what is shown.",
    context ? `Additional context from user: ${context}` : "",
    "",
    "If this is a plant, tree, or yard/garden element:",
    "1. Identify the species (or likely species) as specifically as possible.",
    "2. Provide 3-5 specific care tips relevant right now (watering, pruning, fertilizing, pest watch, etc.).",
    "3. Flag any urgent issues visible (disease, pests, drought stress).",
    "",
    "If this is NOT a plant/yard element, describe what it is and suggest any relevant household maintenance tasks.",
    "",
    "Respond in this exact JSON format (no markdown code fences):",
    JSON.stringify({
      identified: "<species or object name>",
      confidence: "high|medium|low",
      taskTitle: "<short actionable task title for the Family Ledger>",
      taskDetails: "<2-4 sentences of care tips or action details>",
      taskCategory: "yard-care",
      taskPriority: "medium",
      urgentIssue: "<describe urgent issue or empty string>",
      tipsList: ["tip 1", "tip 2", "tip 3"]
    }, null, 2)
  ].filter(Boolean).join("\n");

  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "ai",
        secret: sharedSecret,
        prompt,
        imageBase64,
        imageMediaType,
        max_tokens: 800,
        system: "You are a knowledgeable horticulturist and household maintenance expert. Always respond with valid JSON only — no markdown, no code fences.",
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const raw = data.content || data.text || "";
    let parsed;
    try {
      // Strip any accidental markdown fences
      const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // Fallback: extract what we can
      parsed = {
        identified: "Unknown plant/object",
        confidence: "low",
        taskTitle: "Inspect and identify yard element",
        taskDetails: raw.slice(0, 300),
        taskCategory: "yard-care",
        taskPriority: "medium",
        urgentIssue: "",
        tipsList: [],
      };
    }
    return { ok: true, ...parsed, raw };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
