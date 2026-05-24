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
function tryParseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  try {
    return JSON.parse(body.trim());
  } catch {
    return null;
  }
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
    "`wins` are 1-3 positive observations. `drift` are 1-3 things that slipped or look at risk. " +
    "`suggestion` is one concrete improvement the family could try next week. Keep each item under 110 chars.";

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
export async function brainstormTasks({ backendUrl, sharedSecret, conversation, household, categories, frequencies }) {
  const assignees = [
    ...(household.parentNames || []),
    "Both Parents",
    ...(household.kidNames || []),
    "Anyone",
    "Family",
  ];

  const system =
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
    }
    Set done: true only when the user has explicitly confirmed they're satisfied with the list. ` +
    `On the first message, proposedTasks should usually be empty and you ask a clarifying question.`;

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
  const parsed = tryParseJson(res.data.text || res.data.content || "");
  if (!parsed) return { error: { kind: "parse", message: "Couldn't parse AI response. Try rephrasing." } };
  return parsed;
}
