/* The Family Ledger v2 - see ONBOARDING.md */
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { storage } from "./storage.js";
import {
  pingBackend, loadFromBackend, syncToBackend, webcalUrl, formatDebugInfo,
} from "./sync.js";
import {
  loadIdentity, saveIdentity, clearIdentity, makeIdentity,
  weeklyLeaderboard, personalDailyStreak,
} from "./identity.js";
import {
  suggestTaskMetadata, weeklyRetrospective, staleTaskAdvice, parseDeadline, brainstormTasks,
} from "./ai.js";
import {
  loadEventLog, appendEvent, rerankByUsage,
  findStaleTasks, detectSnoozePatterns, throughputTrend, detectRepeatQuickAdds,
} from "./insights.js";
import {
  isPushSupported, requestPushPermission, subscribeToPush,
  unsubscribeFromPush, getPushStatus,
} from "./push.js";
import {
  Check, Plus, Calendar, Mail, List, Home, Trash2, Edit2, X, Copy,
  AlertCircle, Users, Briefcase, Heart, DollarSign, Baby, Wrench,
  Sparkles, Filter, Flame, Zap, Clock, Download,
  CalendarDays, ReceiptText, PartyPopper, ClipboardList,
  Settings as SettingsIcon, Cloud, CloudOff, Bell, BellOff,
  Wand2, TrendingUp, TrendingDown, Trophy, RefreshCw, ChevronDown,
  Brain, Lightbulb, ArrowRight, MessageCircle, Send,
} from "lucide-react";

/* CONSTANTS */
const STORAGE_KEY  = "family_ledger_v3";
const SETTINGS_KEY = "family_ledger_settings_v3";

const CATEGORIES = [
  { id: "house-care",   label: "House Care",      icon: Wrench,        color: "#4A6B8A" },
  { id: "life-admin",   label: "Life Admin",      icon: ClipboardList, color: "#8B6F2F" },
  { id: "kids",         label: "Kids Activities", icon: Baby,          color: "#A04848" },
  { id: "bills",        label: "Bills",           icon: ReceiptText,   color: "#5C7A3F" },
  { id: "events",       label: "Events",          icon: PartyPopper,   color: "#C9603C" },
  { id: "business",     label: "Business Tasks",  icon: Briefcase,     color: "#4F5D5C" },
  { id: "finance",      label: "Finance",         icon: DollarSign,    color: "#7A5C3F" },
  { id: "health",       label: "Health",          icon: Heart,         color: "#7A4A6B" },
  { id: "family",       label: "Family",          icon: Users,         color: "#B5832E" },
  { id: "other",        label: "Other",           icon: Sparkles,      color: "#6B6B6B" },
];
const FREQUENCIES = [
  { id: "daily",     label: "Daily",         days: 1   },
  { id: "weekly",    label: "Weekly",        days: 7   },
  { id: "biweekly",  label: "Every 2 weeks", days: 14  },
  { id: "monthly",   label: "Monthly",       days: 30  },
  { id: "quarterly", label: "Quarterly",     days: 91  },
  { id: "annual",    label: "Annual",        days: 365 },
  { id: "once",      label: "One time",      days: null },
];
const PRIORITIES = [
  { id: "high",   label: "High",   order: 0, color: "#C9603C" },
  { id: "medium", label: "Medium", order: 1, color: "#8A8579" },
  { id: "low",    label: "Low",    order: 2, color: "#B5B0A4" },
];
const MILESTONES = [3, 5, 10, 25, 52, 100];
const ENV_BACKEND_URL   = (import.meta.env && import.meta.env.VITE_BACKEND_URL)   || "";
const ENV_SHARED_SECRET = (import.meta.env && import.meta.env.VITE_SHARED_SECRET) || "";

/* DATE HELPERS */
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function toISO(d)      { return new Date(d).toISOString().split("T")[0]; }
function getWeekRange(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - day);
  sunday.setHours(0,0,0,0);
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() + 6);
  saturday.setHours(23,59,59,999);
  return { start: sunday, end: saturday };
}
function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function daysUntil(iso) {
  if (!iso) return null;
  const d = startOfDay(iso);
  const t = startOfDay(new Date());
  return Math.round((d - t) / 86400000);
}

/* TASK LOGIC */
function isSnoozed(task) {
  if (!task.snoozedUntil) return false;
  return startOfDay(task.snoozedUntil) > startOfDay(new Date());
}
function isDueThisWeek(task) {
  if (isSnoozed(task)) return false;
  const { end } = getWeekRange();
  const freq = FREQUENCIES.find(f => f.id === task.frequency);
  if (task.frequency === "once") {
    if (!task.deadline) return true;
    return new Date(task.deadline) <= end;
  }
  if (task.frequency === "daily" || task.frequency === "weekly") return true;
  if (!task.lastCompleted) return true;
  const last = new Date(task.lastCompleted);
  const nextDue = new Date(last.getTime() + freq.days * 86400000);
  return nextDue <= end;
}
function calcStreak(task) {
  if (task.frequency === "once") return 0;
  const history = (task.completionHistory || []).map(d => startOfDay(d).getTime());
  if (history.length === 0) return 0;
  const set = new Set(history);
  const freq = FREQUENCIES.find(f => f.id === task.frequency);
  if (task.frequency === "daily") {
    let streak = 0;
    const cursor = startOfDay(new Date());
    if (!set.has(cursor.getTime())) cursor.setDate(cursor.getDate() - 1);
    while (set.has(cursor.getTime())) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }
  const today = startOfDay(new Date()).getTime();
  let streak = 0;
  let windowEnd = today + 86400000;
  let windowStart = windowEnd - freq.days * 86400000;
  const firstDone = history.some(t => t >= windowStart && t < windowEnd);
  if (!firstDone) {
    windowEnd = windowStart;
    windowStart = windowEnd - freq.days * 86400000;
  }
  while (history.some(t => t >= windowStart && t < windowEnd)) {
    streak++;
    windowEnd = windowStart;
    windowStart = windowEnd - freq.days * 86400000;
    if (streak > 500) break;
  }
  return streak;
}

/* ICS */
function generateICS(tasks, reminderMinutes = 60) {
  const lines = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//The Family Ledger//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH"];
  const freqMap = { daily:"DAILY", weekly:"WEEKLY", biweekly:"WEEKLY;INTERVAL=2", monthly:"MONTHLY", quarterly:"MONTHLY;INTERVAL=3", annual:"YEARLY" };
  const fmtDT = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return d.getUTCFullYear() + p(d.getUTCMonth()+1) + p(d.getUTCDate()) +
           "T" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + "00Z";
  };
  const esc = (s) => (s || "").replace(/[\\,;]/g, "\\$&").replace(/\n/g, "\\n");
  tasks.forEach(task => {
    const baseDate = task.deadline ? new Date(task.deadline) : getWeekRange().end;
    const start = new Date(baseDate); start.setHours(9,0,0,0);
    const end = new Date(start); end.setMinutes(start.getMinutes() + 30);
    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + task.id + "@family-ledger");
    lines.push("DTSTAMP:" + fmtDT(new Date()));
    lines.push("DTSTART:" + fmtDT(start));
    lines.push("DTEND:" + fmtDT(end));
    lines.push("SUMMARY:" + esc(task.title));
    let desc = task.details || "";
    desc += "\n\nAssigned: " + task.assignedTo;
    desc += "\nFrequency: " + (FREQUENCIES.find(f => f.id === task.frequency) || {}).label;
    desc += "\nPriority: " + task.priority;
    lines.push("DESCRIPTION:" + esc(desc));
    if (task.frequency !== "once" && freqMap[task.frequency]) {
      lines.push("RRULE:FREQ=" + freqMap[task.frequency]);
    }
    lines.push("BEGIN:VALARM");
    lines.push("TRIGGER:-PT" + reminderMinutes + "M");
    lines.push("ACTION:DISPLAY");
    lines.push("DESCRIPTION:" + esc(task.title));
    lines.push("END:VALARM");
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
function downloadICS(tasks) {
  const blob = new Blob([generateICS(tasks)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "family-ledger-" + toISO(new Date()) + ".ics";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* SEED + DEFAULTS + MIGRATE */
function seedTasks() {
  const today = new Date();
  const inDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return toISO(d); };
  const base = { lastCompleted: null, completionHistory: [], completionLog: [], snoozedUntil: null, lastModified: Date.now() };
  return [
    { ...base, id: "seed_1", title: "Review weekly budget", details: "Reconcile joint checking, review credit card spend.", category: "finance", assignedTo: "Both Parents", frequency: "weekly", deadline: inDays(6), priority: "high", createdAt: Date.now() },
    { ...base, id: "seed_2", title: "Pay mortgage", details: "Auto-pay set, verify it cleared.", category: "bills", assignedTo: "Parent 1", frequency: "monthly", deadline: null, priority: "high", createdAt: Date.now() },
    { ...base, id: "seed_3", title: "Pack school lunches", details: "Prep ingredients Sunday night.", category: "kids", assignedTo: "Anyone", frequency: "daily", deadline: null, priority: "medium", createdAt: Date.now() },
    { ...base, id: "seed_4", title: "Change HVAC filter", details: "20x25x1 MERV 11. Spares in garage shelf.", category: "house-care", assignedTo: "Parent 2", frequency: "monthly", deadline: null, priority: "medium", createdAt: Date.now() },
    { ...base, id: "seed_5", title: "Family meeting", details: "Sunday 6pm. Calendar review, wins of the week.", category: "family", assignedTo: "Family", frequency: "weekly", deadline: null, priority: "high", createdAt: Date.now() },
    { ...base, id: "seed_6", title: "Renew car registration", details: "Tabs expire end of month. State portal.", category: "life-admin", assignedTo: "Parent 1", frequency: "annual", deadline: inDays(21), priority: "high", createdAt: Date.now() },
    { ...base, id: "seed_7", title: "Birthday party planning", details: "Kid's 8th - venue, invites, cake, RSVPs.", category: "events", assignedTo: "Both Parents", frequency: "once", deadline: inDays(30), priority: "medium", createdAt: Date.now() },
  ];
}
const DEFAULT_SETTINGS = {
  parentNames: ["Parent 1", "Parent 2"],
  kidNames: ["Kid 1"],
  parentEmails: ["", ""],
  backendUrl: "",
  sharedSecret: "",
  aiEnabled: true,
  vapidPublicKey: "",
  pushEnabled: false,
  dailyDigestEnabled: false,
};
function migrate(arr) {
  return (arr || []).map(t => {
    const next = {
      snoozedUntil: null, completionHistory: [], completionLog: [],
      lastModified: t.lastModified || Date.now(),
      createdAt: t.createdAt || Date.now(),
      ...t,
    };
    if ((!next.completionLog || next.completionLog.length === 0) && (next.completionHistory || []).length > 0) {
      next.completionLog = next.completionHistory.map(d => ({ date: d, by: "Family" }));
    }
    return next;
  });
}

/* ROOT */
export default function FamilyLedger() {
  const [tasks, setTasks] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [identity, setIdentity] = useState(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [view, setView] = useState("dashboard");
  const [groupBy, setGroupBy] = useState("category");
  const [editingTask, setEditingTask] = useState(null);
  const [filterCategory, setFilterCategory] = useState("all");
  const [filterAssignee, setFilterAssignee] = useState("all");
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState(null);
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncError, setSyncError] = useState(null);
  const [conflictBanner, setConflictBanner] = useState(null);
  const [celebration, setCelebration] = useState(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [events, setEvents] = useState([]);
  const saveTimeoutRef = useRef(null);
  const remoteSnapshotRef = useRef(null);

  const effectiveBackendUrl   = settings.backendUrl   || ENV_BACKEND_URL;
  const effectiveSharedSecret = settings.sharedSecret || ENV_SHARED_SECRET;

  useEffect(() => {
    (async () => {
      try {
        let s = DEFAULT_SETTINGS;
        try {
          const sRes = await storage.get(SETTINGS_KEY);
          if (sRes && sRes.value) s = { ...DEFAULT_SETTINGS, ...JSON.parse(sRes.value) };
        } catch (e) {}
        setSettings(s);
        const id = await loadIdentity();
        setIdentity(id);
        setIdentityReady(true);
        try { setEvents(await loadEventLog()); } catch (e) {}
        const backendUrl = s.backendUrl || ENV_BACKEND_URL;
        const sharedSecret = s.sharedSecret || ENV_SHARED_SECRET;
        if (backendUrl) {
          setSyncStatus("syncing");
          const r = await loadFromBackend(backendUrl, sharedSecret);
          if (r.ok && r.data && r.data.tasks) {
            // First-run auto-persist: if backendUrl/sharedSecret are currently
            // coming from the build-time env vars (not user-saved), promote
            // them to IndexedDB now that we've confirmed the URL works. Without
            // this, users would have to manually open Settings + Save on every
            // new device for cross-device sync to function.
            if ((!s.backendUrl && ENV_BACKEND_URL) || (!s.sharedSecret && ENV_SHARED_SECRET)) {
              s = {
                ...s,
                backendUrl:   s.backendUrl   || ENV_BACKEND_URL,
                sharedSecret: s.sharedSecret || ENV_SHARED_SECRET,
              };
              setSettings(s);
              try { await storage.set(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
            }
            const migrated = migrate(r.data.tasks);
            setTasks(migrated);
            remoteSnapshotRef.current = migrated;
            setSyncStatus("ok");
            setSyncError(null);
            await persistLocal(migrated);
            // Sync household roster from the Sheet (source of truth for names/emails).
            if (r.data.settings) {
              const rs = r.data.settings;
              const hasRoster = (rs.parentNames && rs.parentNames.length > 0)
                             || (rs.kidNames && rs.kidNames.length > 0)
                             || (rs.parentEmails && rs.parentEmails.length > 0);
              if (hasRoster) {
                const merged = {
                  ...s,
                  parentNames:  rs.parentNames  && rs.parentNames.length  > 0 ? rs.parentNames  : s.parentNames,
                  kidNames:     rs.kidNames     && rs.kidNames.length     > 0 ? rs.kidNames     : s.kidNames,
                  parentEmails: rs.parentEmails && rs.parentEmails.length > 0 ? rs.parentEmails : s.parentEmails,
                };
                setSettings(merged);
                try { await storage.set(SETTINGS_KEY, JSON.stringify(merged)); } catch (e) {}
              }
            }
            setLoading(false);
            return;
          }
          if (!r.ok) { setSyncStatus("error"); setSyncError(r.error); }
        }
        try {
          const res = await storage.get(STORAGE_KEY);
          if (res && res.value) {
            const data = JSON.parse(res.value);
            setTasks(migrate(data.tasks || []));
          } else {
            const seeded = seedTasks();
            setTasks(seeded);
            await persistLocal(seeded);
          }
        } catch (e) {
          const seeded = seedTasks();
          setTasks(seeded);
          try { await persistLocal(seeded); } catch (e2) {}
        }
      } catch (e) {
        setStorageError("Couldn't load. Changes may not persist. " + (e.message || ""));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const onUpdate = () => setUpdateReady(true);
    window.addEventListener("ledger:update-ready", onUpdate);
    return () => window.removeEventListener("ledger:update-ready", onUpdate);
  }, []);

  useEffect(() => {
    if (!effectiveBackendUrl) return;
    const interval = setInterval(async () => {
      const r = await loadFromBackend(effectiveBackendUrl, effectiveSharedSecret);
      if (!r.ok || !r.data || !r.data.tasks) return;
      const remote = migrate(r.data.tasks);
      const localById = new Map(tasks.map(t => [t.id, t]));
      const conflicts = remote.filter(rt => {
        const lt = localById.get(rt.id);
        return lt && (rt.lastModified || 0) > (lt.lastModified || 0)
            && JSON.stringify(rt) !== JSON.stringify(lt);
      });
      if (conflicts.length > 0) {
        setConflictBanner({ remoteCount: conflicts.length, remote });
      } else {
        if (JSON.stringify(remote.map(r => r.id).sort()) !==
            JSON.stringify(tasks.map(t => t.id).sort())) {
          setTasks(remote);
          remoteSnapshotRef.current = remote;
          await persistLocal(remote);
        }
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [effectiveBackendUrl, effectiveSharedSecret, tasks]);

  async function persistLocal(nextTasks) {
    try { await storage.set(STORAGE_KEY, JSON.stringify({ tasks: nextTasks })); }
    catch (e) { setStorageError("Local save failed: " + e.message); }
  }

  const persist = useCallback((nextTasks) => {
    setTasks(nextTasks);
    persistLocal(nextTasks);
    if (effectiveBackendUrl) {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      setSyncStatus("syncing");
      saveTimeoutRef.current = setTimeout(async () => {
        const r = await syncToBackend(effectiveBackendUrl, { tasks: nextTasks }, effectiveSharedSecret);
        if (r.ok) { setSyncStatus("ok"); setSyncError(null); remoteSnapshotRef.current = nextTasks; }
        else { setSyncStatus("error"); setSyncError(r.error); }
      }, 800);
    }
  }, [effectiveBackendUrl, effectiveSharedSecret]);

  async function persistSettings(next) {
    setSettings(next);
    try { await storage.set(SETTINGS_KEY, JSON.stringify(next)); }
    catch (e) { setStorageError("Settings save failed: " + e.message); }
  }

  function upsertTask(taskData) {
    let next;
    const stamp = Date.now();
    if (taskData.id && tasks.find(t => t.id === taskData.id)) {
      next = tasks.map(t => t.id === taskData.id ? { ...t, ...taskData, lastModified: stamp } : t);
    } else {
      const created = {
        completionHistory: [], completionLog: [], snoozedUntil: null, lastCompleted: null,
        ...taskData,
        id: taskData.id || "task_" + Date.now() + "_" + Math.random().toString(36).slice(2,7),
        createdAt: stamp, lastModified: stamp,
      };
      next = [...tasks, created];
      appendEvent({ kind: "quick-add", taskId: created.id, meta: {
        title: created.title, category: created.category,
        frequency: created.frequency, assignedTo: created.assignedTo,
      } }).then(loadEventLog).then(setEvents);
    }
    persist(next);
    setEditingTask(null);
    setView("dashboard");
  }

  // Batch version of upsertTask. Use this when adding multiple tasks from
  // a single user action (e.g. Brainstorm "Add selected to ledger"). Calling
  // upsertTask in a loop hits a stale-closure bug because each iteration
  // reads the same tasks snapshot and React batches the setState calls,
  // so only the last task survives. This function builds one next array
  // with all new tasks and calls persist() exactly once.
  function upsertTasks(tasksArray) {
    if (!Array.isArray(tasksArray) || tasksArray.length === 0) return;
    const stamp = Date.now();
    const created = tasksArray.map((td, i) => ({
      completionHistory: [], completionLog: [], snoozedUntil: null, lastCompleted: null,
      ...td,
      id: td.id || "task_" + stamp + "_" + i + "_" + Math.random().toString(36).slice(2,5),
      createdAt: stamp, lastModified: stamp,
    }));
    const next = [...tasks, ...created];
    Promise.all(created.map(c => appendEvent({
      kind: "quick-add", taskId: c.id, meta: {
        title: c.title, category: c.category,
        frequency: c.frequency, assignedTo: c.assignedTo,
      },
    }))).then(loadEventLog).then(setEvents).catch(() => {});
    persist(next);
  }

  function deleteTask(id) {
    appendEvent({ kind: "delete", taskId: id }).then(loadEventLog).then(setEvents);
    persist(tasks.filter(t => t.id !== id));
  }

  function toggleComplete(taskId) {
    const today = toISO(new Date());
    const by = (identity && identity.name) || "Family";
    const next = tasks.map(t => {
      if (t.id !== taskId) return t;
      const history = t.completionHistory || [];
      const log = t.completionLog || [];
      const wasDoneToday = history.includes(today);
      if (wasDoneToday) {
        const filtered = history.filter(d => d !== today);
        const filteredLog = log.filter(e => e.date !== today);
        return { ...t, completionHistory: filtered, completionLog: filteredLog,
          lastCompleted: filtered.sort().pop() || null, lastModified: Date.now() };
      }
      const newHistory = [...history, today].sort();
      const newLog = [...log, { date: today, by }];
      const oldStreak = calcStreak(t);
      const newStreak = calcStreak({ ...t, completionHistory: newHistory });
      if (newStreak > oldStreak && newStreak >= 2) {
        triggerCelebration(t.title, newStreak, identity);
      }
      appendEvent({ kind: "complete", taskId: t.id, meta: { by } }).then(loadEventLog).then(setEvents);
      return { ...t, completionHistory: newHistory, completionLog: newLog,
        lastCompleted: today, lastModified: Date.now() };
    });
    persist(next);
  }

  function snoozeTask(taskId, dateISO) {
    const daysOut = Math.max(0, Math.round((new Date(dateISO) - new Date()) / 86400000));
    appendEvent({ kind: "snooze", taskId, meta: { daysOut } }).then(loadEventLog).then(setEvents);
    persist(tasks.map(t => t.id === taskId ? { ...t, snoozedUntil: dateISO, lastModified: Date.now() } : t));
  }
  function unsnoozeTask(taskId) {
    persist(tasks.map(t => t.id === taskId ? { ...t, snoozedUntil: null, lastModified: Date.now() } : t));
  }
  function triggerCelebration(title, streak, who) {
    const isMilestone = MILESTONES.includes(streak);
    const isKid = who && who.role === "kid";
    setCelebration({ title, streak, isMilestone, isKid, who, key: Date.now() });
    setTimeout(() => setCelebration(null), isMilestone ? 3000 : 1500);
  }
  function adoptRemote() {
    if (!conflictBanner || !conflictBanner.remote) return;
    setTasks(conflictBanner.remote);
    persistLocal(conflictBanner.remote);
    remoteSnapshotRef.current = conflictBanner.remote;
    setConflictBanner(null);
  }
  function keepLocalOverRemote() {
    setConflictBanner(null);
    const stamped = tasks.map(t => ({ ...t, lastModified: Date.now() }));
    persist(stamped);
  }

  const thisWeekTasks = useMemo(() => tasks.filter(isDueThisWeek), [tasks]);
  const completedCount = thisWeekTasks.filter(t => {
    const { start, end } = getWeekRange();
    return (t.completionHistory || []).some(d => { const dd = new Date(d); return dd >= start && dd <= end; });
  }).length;
  const filteredAllTasks = useMemo(() => tasks.filter(t => {
    if (filterCategory !== "all" && t.category !== filterCategory) return false;
    if (filterAssignee !== "all" && t.assignedTo !== filterAssignee) return false;
    return true;
  }), [tasks, filterCategory, filterAssignee]);
  const assigneeOptions = useMemo(() => [
    ...settings.parentNames, "Both Parents", ...(settings.kidNames || []), "Anyone", "Family",
  ], [settings]);
  const aiCfg = {
    backendUrl: effectiveBackendUrl,
    sharedSecret: effectiveSharedSecret,
    enabled: settings.aiEnabled && !!effectiveBackendUrl,
  };

  if (loading || !identityReady) {
    return (
      <div style={styles.loadingShell}>
        <FontStyles />
        <div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, color: "#1B2C3A" }}>Loading the ledger...</div>
      </div>
    );
  }

  if (!identity) {
    return (
      <div style={styles.shell}>
        <FontStyles />
        <div style={styles.grain} />
        <IdentityPicker
          settings={settings}
          onPick={async (data) => { const id = makeIdentity(data); await saveIdentity(id); setIdentity(id); }}
          onSkip={async () => { const id = makeIdentity({ name: "Family", role: "parent" }); await saveIdentity(id); setIdentity(id); }}
        />
      </div>
    );
  }

  return (
    <div style={styles.shell}>
      <FontStyles />
      <KeyframeStyles />
      <div style={styles.grain} />
      <div style={styles.container}>
        <Header
          view={view} setView={setView}
          weekRange={getWeekRange()}
          completedCount={completedCount} totalCount={thisWeekTasks.length}
          syncStatus={syncStatus} syncError={syncError}
          backendUrl={effectiveBackendUrl}
          backendConfigured={!!effectiveBackendUrl}
          identity={identity}
        />

        {updateReady && (
          <div style={styles.updateBanner}>
            <RefreshCw size={16} />
            New version of the ledger is ready.
            <button style={{ ...styles.linkBtn, marginLeft: "auto" }}
              onClick={() => { window.__ledgerUpdateSW && window.__ledgerUpdateSW(true); }}>
              Reload now
            </button>
          </div>
        )}

        {conflictBanner && (
          <div style={styles.conflictBanner}>
            <AlertCircle size={16} />
            A newer copy is on the Sheet ({conflictBanner.remoteCount} task{conflictBanner.remoteCount > 1 ? "s" : ""} changed).
            <button style={styles.linkBtn} onClick={adoptRemote}>Adopt remote</button>
            <button style={styles.linkBtn} onClick={keepLocalOverRemote}>Keep my version</button>
          </div>
        )}

        {storageError && (
          <div style={styles.errorBanner}><AlertCircle size={16} /> {storageError}</div>
        )}

        {syncStatus === "error" && syncError && (
          <SyncErrorBanner error={syncError} backendUrl={effectiveBackendUrl} onRetry={() => persist(tasks)} />
        )}

        {view === "dashboard" && (
          <Dashboard
            tasks={thisWeekTasks} allTasks={tasks}
            onToggle={toggleComplete}
            onEdit={(t) => { setEditingTask(t); setView("add"); }}
            onAdd={() => { setEditingTask(null); setView("add"); }}
            onQuickAdd={upsertTask}
            onSnooze={snoozeTask}
            onExportICS={() => downloadICS(thisWeekTasks)}
            groupBy={groupBy} setGroupBy={setGroupBy}
            assigneeOptions={assigneeOptions}
            events={events} identity={identity} aiCfg={aiCfg}
            categories={CATEGORIES} frequencies={FREQUENCIES}
          />
        )}
        {view === "all" && (
          <AllTasks tasks={filteredAllTasks} allTasks={tasks}
            onEdit={(t) => { setEditingTask(t); setView("add"); }}
            onDelete={deleteTask}
            onAdd={() => { setEditingTask(null); setView("add"); }}
            onUnsnooze={unsnoozeTask}
            onExportICS={() => downloadICS(tasks.filter(t => t.frequency !== "once" || t.deadline))}
            filterCategory={filterCategory} setFilterCategory={setFilterCategory}
            filterAssignee={filterAssignee} setFilterAssignee={setFilterAssignee}
            assigneeOptions={assigneeOptions} />
        )}
        {view === "add" && (
          <TaskForm task={editingTask} onSave={upsertTask}
            onCancel={() => { setEditingTask(null); setView(editingTask ? "all" : "dashboard"); }}
            assigneeOptions={assigneeOptions} aiCfg={aiCfg} />
        )}
        {view === "email" && (
          <EmailPreview tasks={thisWeekTasks} weekRange={getWeekRange()} settings={settings} />
        )}
        {view === "brainstorm" && (
          <BrainstormView
            household={{ parentNames: settings.parentNames, kidNames: settings.kidNames }}
            aiCfg={aiCfg}
            categories={CATEGORIES}
            frequencies={FREQUENCIES}
            assigneeOptions={assigneeOptions}
            onAddTask={upsertTask}
            onAddTasks={upsertTasks}
          />
        )}
        {view === "insights" && (
          <InsightsView tasks={tasks} events={events} aiCfg={aiCfg} identity={identity} settings={settings} />
        )}
        {view === "settings" && (
          <Settings settings={settings} onSave={persistSettings}
            identity={identity}
            onResetIdentity={async () => { await clearIdentity(); setIdentity(null); }}
            backendUrl={effectiveBackendUrl} sharedSecret={effectiveSharedSecret}
            envBackendUrl={ENV_BACKEND_URL} />
        )}
      </div>
      {celebration && <Celebration data={celebration} />}
    </div>
  );
}

/* IDENTITY PICKER */
function IdentityPicker({ settings, onPick, onSkip }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("parent");
  const suggested = [
    ...(settings.parentNames || []).filter(Boolean).map(n => ({ name: n, role: "parent" })),
    ...(settings.kidNames || []).filter(Boolean).map(n => ({ name: n, role: "kid" })),
  ];
  return (
    <div style={{ ...styles.container, maxWidth: 520, paddingTop: 80 }}>
      <div style={styles.formCard}>
        <div style={styles.eyebrow}>Welcome</div>
        <h1 style={{ ...styles.title, fontSize: 36, marginBottom: 16 }}>
          Who's <span style={{ fontStyle: "italic", color: "#C9603C" }}>using</span> this device?
        </h1>
        <p style={{ color: "#6B6B6B", marginTop: 0 }}>
          We'll attribute completions to you so streaks and the weekly leaderboard work.
        </p>
        {suggested.length > 0 && (
          <div style={{ marginTop: 20, marginBottom: 24 }}>
            <label style={styles.label}>Pick from your household</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {suggested.map((s, i) => (
                <button key={i} style={styles.ghostBtn} onClick={() => onPick(s)}>
                  {s.role === "kid" ? "\u{1F98A}" : "\u{1F4D2}"} {s.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div style={{ marginTop: 16 }}>
          <Field label="Or enter a new name" full>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" style={styles.input} />
          </Field>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => setRole("parent")}
              style={{ ...styles.toggleBtn, ...(role === "parent" ? styles.toggleBtnActive : {}), border: "1px solid #D9D2C4", borderRadius: 3 }}>Parent</button>
            <button onClick={() => setRole("kid")}
              style={{ ...styles.toggleBtn, ...(role === "kid" ? styles.toggleBtnActive : {}), border: "1px solid #D9D2C4", borderRadius: 3 }}>Kid</button>
          </div>
        </div>
        <div style={styles.formActions}>
          <button style={styles.ghostBtn} onClick={onSkip}>Skip for now</button>
          <button style={styles.primaryBtn} disabled={!name.trim()} onClick={() => onPick({ name: name.trim(), role })}>
            Continue <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* HEADER */
function Header({ view, setView, weekRange, completedCount, totalCount, syncStatus, syncError, backendUrl, backendConfigured, identity }) {
  const weekLabel = weekRange.start.toLocaleDateString(undefined, { month: "long", day: "numeric" }) + " - " + weekRange.end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const navItems = [
    { id: "dashboard",  label: "This Week",    icon: Home },
    { id: "all",        label: "All Tasks",    icon: List },
    { id: "brainstorm", label: "Brainstorm",   icon: MessageCircle },
    { id: "insights",   label: "Insights",     icon: Brain },
    { id: "email",      label: "Sunday Email", icon: Mail },
    { id: "settings",   label: "Settings",     icon: SettingsIcon },
  ];
  const pct = totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100);
  return (
    <header style={styles.header}>
      <div style={styles.headerTop}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.eyebrow}>
            The Family Ledger · Week of {weekLabel}
            {backendConfigured && <SyncBadge status={syncStatus} error={syncError} backendUrl={backendUrl} />}
          </div>
          <h1 style={styles.title}>
            <span style={{ fontStyle: "italic", color: "#C9603C" }}>House</span> business.
          </h1>
          {identity && (
            <div style={{ fontSize: 13, color: "#8A8579", marginTop: 4 }}>
              Hi, {identity.emoji} {identity.name}.
            </div>
          )}
        </div>
        <div style={styles.scoreCard}>
          <div style={styles.scoreLabel}>This Week</div>
          <div style={styles.scoreValue}>
            {completedCount}<span style={styles.scoreDivider}>/</span><span style={styles.scoreTotal}>{totalCount}</span>
          </div>
          <div style={styles.scoreProgressTrack}>
            <div style={{ ...styles.scoreProgressFill, width: pct + "%" }} />
          </div>
          <div style={styles.scoreSub}>{pct}% complete</div>
        </div>
      </div>
      <nav style={styles.nav}>
        {navItems.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setView(id)}
            style={{ ...styles.navBtn, ...(view === id ? styles.navBtnActive : { borderBottomColor: "transparent" }) }}>
            <Icon size={15} strokeWidth={1.75} /><span>{label}</span>
          </button>
        ))}
      </nav>
    </header>
  );
}

function SyncBadge({ status, error, backendUrl }) {
  const [open, setOpen] = useState(false);
  const map = {
    syncing: { Icon: Cloud,    color: "#8A8579", text: "syncing..." },
    ok:      { Icon: Cloud,    color: "#5C7A3F", text: "synced" },
    error:   { Icon: CloudOff, color: "#A04848", text: "sync error" },
    queued:  { Icon: Cloud,    color: "#8A8579", text: "queued (offline)" },
    idle:    { Icon: Cloud,    color: "#8A8579", text: "ready" },
  };
  const { Icon, color, text } = map[status] || map.idle;
  const errorMsg = error ? error.message + (error.hint ? " · " + error.hint : "") : "";
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <span onClick={() => error && setOpen(o => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 12, color, fontSize: 11, cursor: error ? "pointer" : "default" }}
        title={errorMsg}>
        <Icon size={12} /> {text}
        {error && <ChevronDown size={11} />}
      </span>
      {open && error && (
        <div style={styles.syncErrorPopover}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{error.message}</div>
          {error.hint && <div style={{ fontSize: 11, color: "#8A8579", marginBottom: 8 }}>{error.hint}</div>}
          <button style={{ ...styles.linkBtn, padding: 0 }}
            onClick={() => { navigator.clipboard.writeText(formatDebugInfo(error, backendUrl)).catch(() => {}); setOpen(false); }}>
            Copy debug info
          </button>
        </div>
      )}
    </span>
  );
}

function SyncErrorBanner({ error, backendUrl, onRetry }) {
  return (
    <div style={styles.errorBanner}>
      <AlertCircle size={16} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div><strong>Sync failed:</strong> {error.message}</div>
        {error.hint && <div style={{ fontSize: 12, color: "#6B5444", marginTop: 2 }}>{error.hint}</div>}
      </div>
      <button style={styles.linkBtn} onClick={onRetry}>Retry</button>
      <button style={styles.linkBtn}
        onClick={() => navigator.clipboard.writeText(formatDebugInfo(error, backendUrl)).catch(() => {})}>
        Copy debug info
      </button>
    </div>
  );
}

/* DASHBOARD */
function Dashboard({ tasks, allTasks, onToggle, onEdit, onAdd, onQuickAdd, onSnooze, onExportICS, groupBy, setGroupBy, assigneeOptions, events, identity, aiCfg, categories, frequencies }) {
  const grouped = useMemo(() => {
    const g = {};
    if (groupBy === "category") tasks.forEach(t => { (g[t.category] ||= []).push(t); });
    else tasks.forEach(t => { (g[t.priority] ||= []).push(t); });
    return g;
  }, [tasks, groupBy]);
  const groupOrder = groupBy === "category" ? CATEGORIES.map(c => c.id) : PRIORITIES.map(p => p.id);
  const getMeta = (key) => groupBy === "category" ? CATEGORIES.find(c => c.id === key) : PRIORITIES.find(p => p.id === key);

  if (tasks.length === 0) {
    return (
      <>
        <QuickAdd onAdd={onQuickAdd} assigneeOptions={assigneeOptions} events={events} aiCfg={aiCfg} categories={categories} frequencies={frequencies} />
        <div style={styles.emptyState}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, margin: "0 0 8px" }}>A clean slate this week.</h2>
          <p style={{ color: "#6B6B6B", margin: "0 0 24px" }}>Nothing due. Quick-add a task above, or open the full form.</p>
          <button style={styles.primaryBtn} onClick={onAdd}><Plus size={16} /> Add a task</button>
        </div>
      </>
    );
  }

  return (
    <div>
      <QuickAdd onAdd={onQuickAdd} assigneeOptions={assigneeOptions} events={events} aiCfg={aiCfg} categories={categories} frequencies={frequencies} />
      <LeaderboardStrip allTasks={allTasks} identity={identity} />
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>This week's plays</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={styles.toggleGroup}>
            <button onClick={() => setGroupBy("category")}
              style={{ ...styles.toggleBtn, ...(groupBy === "category" ? styles.toggleBtnActive : {}) }}>By category</button>
            <button onClick={() => setGroupBy("priority")}
              style={{ ...styles.toggleBtn, ...(groupBy === "priority" ? styles.toggleBtnActive : {}) }}>By priority</button>
          </div>
          <button style={styles.ghostBtn} onClick={onExportICS}><CalendarDays size={14} /> Export</button>
          <button style={styles.primaryBtn} onClick={onAdd}><Plus size={16} /> Add</button>
        </div>
      </div>
      {groupOrder.map(key => {
        const items = grouped[key];
        if (!items || items.length === 0) return null;
        const meta = getMeta(key);
        const doneCount = items.filter(t => {
          const { start, end } = getWeekRange();
          return (t.completionHistory || []).some(d => new Date(d) >= start && new Date(d) <= end);
        }).length;
        return (
          <section key={key} style={styles.categorySection}>
            <div style={styles.categoryHeader}>
              <div style={{ ...styles.categoryDot, backgroundColor: meta.color }} />
              <h3 style={styles.categoryTitle}>{meta.label}{groupBy === "priority" ? " priority" : ""}</h3>
              <div style={styles.categoryCount}>{doneCount} / {items.length}</div>
            </div>
            <div style={styles.taskGrid}>
              {items.map(t => (
                <TaskCard key={t.id} task={t}
                  onToggle={() => onToggle(t.id)}
                  onEdit={() => onEdit(t)}
                  onSnooze={(d) => onSnooze(t.id, d)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function LeaderboardStrip({ allTasks, identity }) {
  const { start, end } = getWeekRange();
  const board = useMemo(() => weeklyLeaderboard(allTasks, start, end), [allTasks, start, end]);
  if (board.length === 0) return null;
  const max = Math.max(1, ...board.map(b => b.count));
  return (
    <div style={styles.leaderboardCard}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Trophy size={16} color="#C9603C" />
        <h3 style={{ ...styles.categoryTitle, fontSize: 14, margin: 0 }}>This week's leaderboard</h3>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {board.map(({ name, count }) => {
          const me = identity && identity.name === name;
          return (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 110, fontSize: 13, fontWeight: me ? 600 : 400, color: me ? "#1B2C3A" : "#6B6B6B" }}>
                {name}{me ? " (you)" : ""}
              </div>
              <div style={{ flex: 1, height: 6, background: "#F2EDE4", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: (count / max * 100) + "%", background: me ? "#C9603C" : "#1B2C3A" }} />
              </div>
              <div style={{ width: 32, fontSize: 12, fontVariantNumeric: "tabular-nums", textAlign: "right", color: "#8A8579" }}>{count}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* TASK CARD */
function renderDetails(text) {
  if (!text) return null;
  const urlRegex = /(https?://[^s]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) =>
    urlRegex.test(part)
      ? <a key={i} href={part} target="_blank" rel="noreferrer noopener"
          style={{ color: "#C9603C", textDecoration: "underline", wordBreak: "break-all" }}>{part}</a>
      : part
  );
}

function TaskCard({ task, onToggle, onEdit, onSnooze }) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const cat = CATEGORIES.find(c => c.id === task.category) || CATEGORIES[CATEGORIES.length - 1];
  const freq = FREQUENCIES.find(f => f.id === task.frequency);
  const dDays = daysUntil(task.deadline);
  const streak = calcStreak(task);
  const priorityMeta = PRIORITIES.find(p => p.id === task.priority);
  const { start, end } = getWeekRange();
  const isDone = (task.completionHistory || []).some(d => { const dd = new Date(d); return dd >= start && dd <= end; });
  const snoozeFor = (offset) => {
    const d = new Date(); d.setDate(d.getDate() + offset);
    onSnooze(toISO(d));
    setSnoozeOpen(false);
  };
  return (
    <div style={{
      ...styles.taskCard,
      ...(isDone ? styles.taskCardDone : {}),
      borderLeftColor: cat.color,
      borderLeftWidth: task.priority === "high" ? 4 : 3,
    }}>
      <button onClick={onToggle} className="ledger-checkbox" style={{
        ...styles.checkbox,
        backgroundColor: isDone ? "#1B2C3A" : "transparent",
        borderColor: isDone ? "#1B2C3A" : "#C9C2B5",
      }} aria-label={isDone ? "Mark incomplete" : "Mark complete"}>
        {isDone && <Check size={14} color="#FAF7F2" strokeWidth={3} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={styles.taskTitleRow}>
          <h4 style={{ ...styles.taskTitle,
            textDecoration: isDone ? "line-through" : "none",
            color: isDone ? "#9A9489" : "#1B2C3A",
          }}>{task.title}</h4>
          {streak >= 2 && <StreakBadge streak={streak} muted={isDone} />}
          {task.priority === "high" && !isDone && (<span style={styles.priorityHigh}>Priority</span>)}
          {task.notify && !isDone && (<Bell size={12} color="#8A8579" style={{ marginLeft: 4, flexShrink: 0 }} title="Notifications on" />)}
        </div>
        {task.details && <p style={styles.taskDetails}>{renderDetails(task.details)}</p>}
        <div style={styles.taskMeta}>
          <span style={styles.metaChip}><Users size={11} /> {task.assignedTo}</span>
          <span style={styles.metaChip}>{freq && freq.label}</span>
          {task.deadline && (
            <span style={{ ...styles.metaChip,
              color: dDays !== null && dDays < 0 ? "#A04848" : (dDays !== null && dDays <= 2 ? "#C9603C" : "#8A8579"),
              fontWeight: dDays !== null && dDays <= 2 ? 600 : 400,
            }}>
              <Calendar size={11} /> {formatDate(task.deadline)}
              {dDays !== null && dDays <= 7 && dDays >= 0 && " · " + dDays + "d"}
              {dDays !== null && dDays < 0 && " · overdue"}
            </span>
          )}
          <span style={{ ...styles.metaChip, color: priorityMeta && priorityMeta.color }}>
            • {priorityMeta && priorityMeta.label.toLowerCase()}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 2, position: "relative" }}>
        <button onClick={() => setSnoozeOpen(s => !s)} style={styles.iconBtn} title="Snooze"><Clock size={14} /></button>
        <button onClick={onEdit} style={styles.iconBtn} aria-label="Edit"><Edit2 size={14} /></button>
        {snoozeOpen && (
          <SnoozeMenu onPick={snoozeFor}
            onCustom={(d) => { onSnooze(d); setSnoozeOpen(false); }}
            onClose={() => setSnoozeOpen(false)} />
        )}
      </div>
    </div>
  );
}

function StreakBadge({ streak, muted }) {
  return (
    <span className={muted ? "" : "ledger-streak-pulse"} style={{ ...styles.streakBadge, opacity: muted ? 0.5 : 1 }}>
      <Flame size={11} strokeWidth={2.25} />{streak}
    </span>
  );
}

function SnoozeMenu({ onPick, onCustom, onClose }) {
  const [customDate, setCustomDate] = useState("");
  useEffect(() => {
    const handler = (e) => { if (!e.target.closest(".snooze-menu")) onClose(); };
    setTimeout(() => document.addEventListener("click", handler), 0);
    return () => document.removeEventListener("click", handler);
  }, [onClose]);
  return (
    <div className="snooze-menu" style={styles.snoozeMenu}>
      <div style={styles.snoozeTitle}>Snooze until...</div>
      <button style={styles.snoozeItem} onClick={() => onPick(1)}>Tomorrow</button>
      <button style={styles.snoozeItem} onClick={() => onPick(7)}>Next week</button>
      <button style={styles.snoozeItem} onClick={() => onPick(14)}>In 2 weeks</button>
      <button style={styles.snoozeItem} onClick={() => onPick(30)}>Next month</button>
      <div style={styles.snoozeCustom}>
        <input type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)}
          style={{ ...styles.input, padding: "6px 8px", fontSize: 12 }} />
        <button style={{ ...styles.primaryBtn, padding: "6px 10px", fontSize: 12 }}
          onClick={() => customDate && onCustom(customDate)}>Set</button>
      </div>
    </div>
  );
}

/* QUICK ADD */
function QuickAdd({ onAdd, assigneeOptions, events, aiCfg, categories, frequencies }) {
  const [title, setTitle] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [category, setCategory] = useState("life-admin");
  const [frequency, setFrequency] = useState("weekly");
  const [assignedTo, setAssignedTo] = useState("Anyone");
  const [priority, setPriority] = useState("medium");
  const [deadline, setDeadline] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiHint, setAiHint] = useState(null);

  const sortedCategories = useMemo(() => rerankByUsage(categories, events, (m) => m.category), [events, categories]);
  const sortedFrequencies = useMemo(() => rerankByUsage(frequencies, events, (m) => m.frequency), [events, frequencies]);

  const submit = () => {
    if (!title.trim()) return;
    onAdd({ title: title.trim(), details: "", category, frequency, assignedTo, priority, deadline: deadline || null });
    setTitle(""); setDeadline(""); setAiHint(null); setExpanded(false);
  };

  const autoFill = async () => {
    if (!aiCfg.enabled) { setAiHint({ error: "Enable the AI agent (Settings > AI agent)." }); return; }
    if (!title.trim()) return;
    setAiBusy(true); setAiHint(null);
    const r = await suggestTaskMetadata({
      backendUrl: aiCfg.backendUrl, sharedSecret: aiCfg.sharedSecret,
      title: title.trim(), knownAssignees: assigneeOptions, categories, frequencies,
    });
    setAiBusy(false);
    if (!r || r.error) { setAiHint({ error: (r && r.error && r.error.message) || "AI couldn't help." }); return; }
    if (r.category)   setCategory(r.category);
    if (r.frequency)  setFrequency(r.frequency);
    if (r.priority)   setPriority(r.priority);
    if (r.assignedTo && assigneeOptions.includes(r.assignedTo)) setAssignedTo(r.assignedTo);
    if (r.deadline)   setDeadline(r.deadline);
    setAiHint({ ok: "Filled from title - review below." });
  };

  return (
    <div style={{ ...styles.quickAdd, ...(expanded ? styles.quickAddExpanded : {}) }}>
      <div style={styles.quickAddRow}>
        <Zap size={16} color="#C9603C" strokeWidth={2.25} />
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          onFocus={() => setExpanded(true)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setExpanded(false); }}
          placeholder="Quick add a task and hit Enter..."
          style={styles.quickAddInput} />
        {expanded && (
          <>
            <button style={styles.ghostBtn} onClick={autoFill} disabled={aiBusy || !title.trim()}
              title="Ask the AI to fill category/frequency/priority">
              <Wand2 size={14} /> {aiBusy ? "Thinking..." : "AI fill"}
            </button>
            <button style={styles.primaryBtn} onClick={submit}>Add</button>
          </>
        )}
      </div>
      {expanded && (
        <>
          <div style={styles.quickAddOptions}>
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={styles.select}>
              {sortedCategories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)} style={styles.select}>
              {sortedFrequencies.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} style={styles.select}>
              {assigneeOptions.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} style={styles.select}>
              {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)}
              style={{ ...styles.select, padding: "6px 10px" }} />
            <button style={styles.ghostBtn} onClick={() => setExpanded(false)}><X size={14} /></button>
          </div>
          {aiHint && (
            <div style={{ fontSize: 12, marginTop: 8, color: aiHint.error ? "#A04848" : "#5C7A3F" }}>
              {aiHint.error || aiHint.ok}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ALL TASKS */
function AllTasks({ tasks, allTasks, onEdit, onDelete, onAdd, onUnsnooze, onExportICS, filterCategory, setFilterCategory, filterAssignee, setFilterAssignee, assigneeOptions }) {
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  return (
    <div>
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>Every task ({tasks.length}{tasks.length !== allTasks.length ? ` of ${allTasks.length}` : ""})</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={styles.ghostBtn} onClick={onExportICS}><Download size={14} /> Export all (.ics)</button>
          <button style={styles.primaryBtn} onClick={onAdd}><Plus size={16} /> Add task</button>
        </div>
      </div>
      <div style={styles.filterBar}>
        <div style={styles.filterGroup}>
          <Filter size={13} color="#6B6B6B" />
          <span style={styles.filterLabel}>Category</span>
          <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} style={styles.select}>
            <option value="all">All</option>
            {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div style={styles.filterGroup}>
          <span style={styles.filterLabel}>Assigned to</span>
          <select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)} style={styles.select}>
            <option value="all">All</option>
            {assigneeOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={styles.table}>
          <thead>
            <tr style={styles.tableHeadRow}>
              <th style={styles.th}>Task</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Assigned</th>
              <th style={styles.th}>Frequency</th>
              <th style={styles.th}>Deadline</th>
              <th style={styles.th}>Priority</th>
              <th style={styles.th}>Streak</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {tasks.map(t => {
              const cat = CATEGORIES.find(c => c.id === t.category);
              const freq = FREQUENCIES.find(f => f.id === t.frequency);
              const streak = calcStreak(t);
              const snoozed = isSnoozed(t);
              return (
                <tr key={t.id} style={styles.tableRow}>
                  <td style={styles.td}>
                    <div style={{ fontWeight: 500, color: "#1B2C3A" }}>{t.title}</div>
                    {t.details && (
                      <div style={{ fontSize: 12, color: "#8A8579", marginTop: 2 }}>
                        {renderDetails(t.details.length > 120 ? t.details.slice(0, 120) + "..." : t.details)}
                      </div>
                    )}
                  </td>
                  <td style={styles.td}>
                    <span style={{ ...styles.categoryPill, borderColor: cat && cat.color, color: cat && cat.color }}>{cat && cat.label}</span>
                  </td>
                  <td style={styles.td}>{t.assignedTo}</td>
                  <td style={styles.td}>{freq && freq.label}</td>
                  <td style={styles.td}>{formatDate(t.deadline) || "--"}</td>
                  <td style={styles.td}>
                    <span style={{ ...styles.priorityPill,
                      ...(t.priority === "high" ? styles.priorityPillHigh : {}),
                      ...(t.priority === "low" ? styles.priorityPillLow : {}),
                    }}>{t.priority}</span>
                  </td>
                  <td style={styles.td}>
                    {streak >= 2 ? <StreakBadge streak={streak} muted /> : <span style={{ color: "#C9C2B5" }}>--</span>}
                  </td>
                  <td style={styles.td}>
                    {snoozed ? (
                      <button style={styles.snoozedPill} onClick={() => onUnsnooze(t.id)} title="Unsnooze">
                        <Clock size={11} /> snoozed · {formatDate(t.snoozedUntil)}
                      </button>
                    ) : (<span style={{ color: "#C9C2B5" }}>active</span>)}
                  </td>
                  <td style={styles.td}>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button style={styles.iconBtn} onClick={() => onEdit(t)}><Edit2 size={13} /></button>
                      <button style={{ ...styles.iconBtn, color: "#A04848" }}
                        onClick={() => setConfirmDeleteId(t.id)} style={{ ...(confirmDeleteId === t.id ? { color: "#A04848", fontWeight: 700 } : {}) }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {confirmDeleteId === t.id && (
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                        <span style={{ fontSize: 12, color: "#A04848" }}>Delete this task?</span>
                        <button style={{ fontSize: 11, padding: "2px 8px", background: "#A04848", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer" }} onClick={() => { onDelete(t.id); setConfirmDeleteId(null); }}>Yes, delete</button>
                        <button style={{ fontSize: 11, padding: "2px 8px", background: "transparent", border: "1px solid #D9D2C4", borderRadius: 3, cursor: "pointer" }} onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* TASK FORM */
function TaskForm({ task, onSave, onCancel, assigneeOptions, aiCfg }) {
  const [form, setForm] = useState(task ? { ...task, deadline: task.deadline ? task.deadline.slice(0, 10) : "" } : {
    title: "", details: "", category: "life-admin", assignedTo: "Anyone",
    frequency: "weekly", deadline: "", priority: "medium", notify: true,
  });
  const [parseBusy, setParseBusy] = useState(false);
  const [parseHint, setParseHint] = useState(null);
  const [phrase, setPhrase] = useState("");
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [titleError, setTitleError] = useState(false);
  const submit = () => {
    if (!form.title.trim()) { setTitleError(true); return; }
    setTitleError(false);
    onSave({ ...form, deadline: form.deadline || null });
  };

  const parseAndApply = async () => {
    if (!aiCfg || !aiCfg.enabled || !phrase.trim()) return;
    setParseBusy(true); setParseHint(null);
    const r = await parseDeadline({
      backendUrl: aiCfg.backendUrl, sharedSecret: aiCfg.sharedSecret,
      phrase: phrase.trim(), today: toISO(new Date()),
    });
    setParseBusy(false);
    if (!r || r.error || !r.iso) { setParseHint({ error: (r && r.error && r.error.message) || "Couldn't parse that." }); return; }
    update("deadline", r.iso);
    setParseHint({ ok: "Set to " + (r.label || r.iso) });
  };

  return (
    <div style={styles.formCard}>
      <div style={styles.formHeader}>
        <h2 style={styles.sectionTitle}>{task ? "Edit task" : "New task"}</h2>
        <button onClick={onCancel} style={styles.iconBtn}><X size={18} /></button>
      </div>
      <div style={styles.formGrid}>
        <Field label="Title" full>
          <input value={form.title} onChange={(e) => { update("title", e.target.value); if (e.target.value.trim()) setTitleError(false); }}
            placeholder="e.g. File Q1 sales tax" style={{ ...styles.input, ...(titleError ? { borderColor: "#A04848", boxShadow: "0 0 0 2px rgba(160,72,72,0.2)" } : {}) }} />
          {titleError && <div style={{ color: "#A04848", fontSize: 12, marginTop: 4 }}>Title is required</div>}
        </Field>
        <Field label="Details" full>
          <textarea value={form.details} onChange={(e) => update("details", e.target.value)}
            placeholder="Account numbers, links, instructions, anything the other parent needs."
            rows={3} style={{ ...styles.input, fontFamily: "inherit", resize: "vertical" }} />
        </Field>
        <Field label="Category">
          <select value={form.category} onChange={(e) => update("category", e.target.value)} style={styles.input}>
            {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Assigned to">
          <select value={form.assignedTo} onChange={(e) => update("assignedTo", e.target.value)} style={styles.input}>
            {assigneeOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Frequency">
          <select value={form.frequency} onChange={(e) => update("frequency", e.target.value)} style={styles.input}>
            {FREQUENCIES.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select value={form.priority} onChange={(e) => update("priority", e.target.value)} style={styles.input}>
            {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Field>
        <Field label="Deadline (optional)" full>
          <input type="date" value={form.deadline || ""} onChange={(e) => update("deadline", e.target.value)} style={styles.input} />
          {aiCfg && aiCfg.enabled && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input value={phrase} onChange={(e) => setPhrase(e.target.value)}
                placeholder='or type "next Friday", "end of month"'
                style={{ ...styles.input, flex: 1 }} />
              <button onClick={parseAndApply} style={styles.ghostBtn} disabled={parseBusy || !phrase.trim()}>
                <Wand2 size={14} /> {parseBusy ? "Parsing..." : "Set"}
              </button>
            </div>
          )}
          {parseHint && (
            <div style={{ fontSize: 12, marginTop: 6, color: parseHint.error ? "#A04848" : "#5C7A3F" }}>
              {parseHint.error || parseHint.ok}
            </div>
          )}
        </Field>
        <Field label="Notifications" full>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            <input type="checkbox" id="notify-toggle" checked={!!form.notify}
              onChange={(e) => update("notify", e.target.checked)} />
            <label htmlFor="notify-toggle" style={{ fontSize: 14, color: "#1B2C3A" }}>
              Send push notification reminders for this task
            </label>
          </div>
        </Field>
      </div>
      <div style={styles.formActions}>
        <button onClick={onCancel} style={styles.ghostBtn}>Cancel</button>
        <button onClick={submit} style={styles.primaryBtn}>{task ? "Save changes" : "Add task"}</button>
      </div>
    </div>
  );
}

function Field({ label, full, children }) {
  return (
    <div style={{ gridColumn: full ? "1 / -1" : "auto" }}>
      <label style={styles.label}>{label}</label>
      {children}
    </div>
  );
}

/* EMAIL PREVIEW */
function EmailPreview({ tasks, weekRange, settings }) {
  const [copied, setCopied] = useState(false);
  const grouped = useMemo(() => { const g = {}; tasks.forEach(t => { (g[t.category] ||= []).push(t); }); return g; }, [tasks]);
  const subject = "The Week of " + weekRange.start.toLocaleDateString(undefined, { month: "long", day: "numeric" }) + " - " + tasks.length + " items on the ledger";
  const emailText = useMemo(() => {
    const lines = [];
    lines.push("Good Sunday morning, " + settings.parentNames.join(" & ") + ".");
    lines.push("");
    lines.push("Here's what's on the ledger this week (" + tasks.length + " items):");
    lines.push("");
    CATEGORIES.forEach(cat => {
      const items = grouped[cat.id];
      if (!items || items.length === 0) return;
      lines.push("## " + cat.label.toUpperCase());
      items.forEach(t => {
        const freq = FREQUENCIES.find(f => f.id === t.frequency);
        const deadline = t.deadline ? " · due " + formatDate(t.deadline) : "";
        const prio = t.priority === "high" ? " · PRIORITY" : "";
        const streak = calcStreak(t);
        const streakStr = streak >= 2 ? " · \u{1F525}" + streak : "";
        lines.push("• " + t.title + " (" + t.assignedTo + " · " + freq.label + deadline + streakStr + ")" + prio);
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
  }, [tasks, grouped, settings]);
  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText("Subject: " + subject + "\n\n" + emailText);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch (e) { alert("Copy failed: " + e.message); }
  };
  return (
    <div>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.sectionTitle}>Sunday morning email</h2>
          <p style={{ color: "#6B6B6B", fontSize: 14, margin: "4px 0 0" }}>
            This is what Apps Script sends every Sunday at 7am from your configured backend.
          </p>
        </div>
        <button style={styles.primaryBtn} onClick={copyEmail}>
          <Copy size={16} /> {copied ? "Copied!" : "Copy email"}
        </button>
      </div>
      <div style={styles.emailCard}>
        <div style={styles.emailMeta}>
          <div><span style={styles.emailMetaLabel}>From</span><span>The Family Ledger</span></div>
          <div><span style={styles.emailMetaLabel}>To</span><span>{settings.parentEmails.filter(Boolean).join(", ") || settings.parentNames.join(", ")}</span></div>
          <div><span style={styles.emailMetaLabel}>Subject</span><span style={{ fontWeight: 500 }}>{subject}</span></div>
        </div>
        <pre style={styles.emailBody}>{emailText}</pre>
      </div>
    </div>
  );
}

/* INSIGHTS */
function InsightsView({ tasks, events, aiCfg, identity, settings }) {
  const trend = useMemo(() => throughputTrend(tasks), [tasks]);
  const stale = useMemo(() => findStaleTasks(tasks, 30), [tasks]);
  const snoozePatterns = useMemo(() => detectSnoozePatterns(events), [events]);
  const repeats = useMemo(() => detectRepeatQuickAdds(events), [events]);
  const myStreak = useMemo(() => personalDailyStreak(tasks, identity && identity.name), [tasks, identity]);
  const [retro, setRetro] = useState(null);
  const [retroBusy, setRetroBusy] = useState(false);

  const runRetro = async () => {
    if (!aiCfg.enabled) return;
    setRetroBusy(true);
    const snapshot = {
      throughput: trend,
      leaderboard: weeklyLeaderboard(tasks, getWeekRange().start, getWeekRange().end),
      staleCount: stale.length,
      snoozePatternCount: snoozePatterns.length,
      tasks: tasks.slice(0, 40).map(t => ({
        title: t.title, category: t.category, frequency: t.frequency, priority: t.priority,
        lastCompleted: t.lastCompleted,
        completionsThisWeek: (t.completionHistory || []).filter(d => new Date(d) >= getWeekRange().start).length,
        snoozed: !!t.snoozedUntil,
      })),
    };
    const r = await weeklyRetrospective({ backendUrl: aiCfg.backendUrl, sharedSecret: aiCfg.sharedSecret, snapshot });
    setRetroBusy(false);
    if (r && !r.error) setRetro(r);
    else setRetro({ error: (r && r.error && r.error.message) || "AI unavailable." });
  };

  const trendDelta = trend.thisWeek - trend.lastWeek;
  const TrendIcon = trendDelta >= 0 ? TrendingUp : TrendingDown;
  const trendColor = trendDelta >= 0 ? "#5C7A3F" : "#A04848";

  return (
    <div>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.sectionTitle}>Insights</h2>
          <p style={{ color: "#6B6B6B", fontSize: 14, margin: "4px 0 0" }}>
            How the household is trending. The ledger watches itself and surfaces patterns.
          </p>
        </div>
        {aiCfg.enabled && (
          <button style={styles.primaryBtn} onClick={runRetro} disabled={retroBusy}>
            <Brain size={16} /> {retroBusy ? "Reflecting..." : "Run weekly retrospective"}
          </button>
        )}
      </div>
      <div style={styles.insightGrid}>
        <div style={styles.insightCard}>
          <div style={styles.insightLabel}>Throughput</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <div style={styles.insightValue}>{trend.thisWeek}</div>
            <TrendIcon size={18} color={trendColor} />
            <div style={{ fontSize: 13, color: trendColor, fontWeight: 500 }}>
              {trendDelta >= 0 ? "+" : ""}{trendDelta}
            </div>
          </div>
          <div style={styles.insightSub}>vs {trend.lastWeek} last week, {trend.priorWeek} prior</div>
        </div>
        <div style={styles.insightCard}>
          <div style={styles.insightLabel}>Your daily streak</div>
          <div style={styles.insightValue}>{myStreak}</div>
          <div style={styles.insightSub}>{identity && identity.emoji} {identity && identity.name}</div>
        </div>
        <div style={styles.insightCard}>
          <div style={styles.insightLabel}>Stale tasks (30+ days)</div>
          <div style={{ ...styles.insightValue, color: stale.length > 5 ? "#A04848" : "#1B2C3A" }}>{stale.length}</div>
          <div style={styles.insightSub}>candidates for review or delete</div>
        </div>
        <div style={styles.insightCard}>
          <div style={styles.insightLabel}>Detected snooze patterns</div>
          <div style={styles.insightValue}>{snoozePatterns.length}</div>
          <div style={styles.insightSub}>tasks you keep pushing the same number of days</div>
        </div>
      </div>
      {retro && !retro.error && (
        <div style={styles.retroCard}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <Lightbulb size={16} color="#C9603C" />
            <h3 style={{ ...styles.categoryTitle, margin: 0 }}>This week's retrospective</h3>
          </div>
          {retro.wins && retro.wins.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={styles.retroSection}>Wins</div>
              {retro.wins.map((w, i) => <div key={i} style={styles.retroBullet}>• {w}</div>)}
            </div>
          )}
          {retro.drift && retro.drift.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={styles.retroSection}>Drift</div>
              {retro.drift.map((w, i) => <div key={i} style={styles.retroBullet}>• {w}</div>)}
            </div>
          )}
          {retro.suggestion && (
            <div style={styles.retroSuggestion}>
              <ArrowRight size={14} color="#C9603C" /> {retro.suggestion}
            </div>
          )}
        </div>
      )}
      {retro && retro.error && (
        <div style={styles.errorBanner}><AlertCircle size={16} /> {retro.error}</div>
      )}
      {snoozePatterns.length > 0 && (
        <div style={styles.formCard}>
          <h3 style={{ ...styles.categoryTitle, marginBottom: 12 }}>Patterns to consider</h3>
          {snoozePatterns.map(p => {
            const t = tasks.find(x => x.id === p.taskId);
            if (!t) return null;
            return (
              <div key={p.taskId} style={{ padding: "10px 0", borderTop: "1px solid #F0EAE0" }}>
                <strong>{t.title}</strong> - you snooze this by ~{p.suggestedDays} days every time ({p.confidence}x). Consider changing the frequency or deadline so it lines up.
              </div>
            );
          })}
        </div>
      )}
      {repeats.length > 0 && (
        <div style={{ ...styles.formCard, marginTop: 16 }}>
          <h3 style={{ ...styles.categoryTitle, marginBottom: 12 }}>Looks recurring</h3>
          <p style={{ fontSize: 13, color: "#8A8579", marginBottom: 8 }}>
            You've added these as one-offs multiple times. Consider making them recurring.
          </p>
          {repeats.map((r, i) => (
            <div key={i} style={{ padding: "8px 0", borderTop: "1px solid #F0EAE0" }}>
              <strong>{r.title}</strong> · added {r.count} times
            </div>
          ))}
        </div>
      )}
      {stale.length > 0 && (
        <div style={{ ...styles.formCard, marginTop: 16 }}>
          <h3 style={{ ...styles.categoryTitle, marginBottom: 12 }}>Stale ({stale.length})</h3>
          <p style={{ fontSize: 13, color: "#8A8579", marginBottom: 8 }}>
            Not completed in 30+ days. Edit, snooze, or delete from All Tasks.
          </p>
          {stale.slice(0, 10).map(t => (
            <div key={t.id} style={{ padding: "8px 0", borderTop: "1px solid #F0EAE0", fontSize: 14 }}>
              {t.title} <span style={{ color: "#8A8579", fontSize: 12 }}>
                - {t.lastCompleted ? "last done " + formatDate(t.lastCompleted) : "never completed"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* SETTINGS */
function Settings({ settings, onSave, identity, onResetIdentity, backendUrl, sharedSecret, envBackendUrl }) {
  const [draft, setDraft] = useState({ ...settings, backendUrl: settings.backendUrl || envBackendUrl });
  const [saved, setSaved] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [testError, setTestError] = useState(null);
  const [pushStatus, setPushStatus] = useState({ supported: false });

  useEffect(() => { getPushStatus().then(setPushStatus); }, []);
  const update = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const save = async () => { await onSave(draft); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  const updateKid = (i, v) => { const next = [...draft.kidNames]; next[i] = v; update("kidNames", next); };
  const addKid = () => update("kidNames", [...draft.kidNames, "Kid " + (draft.kidNames.length + 1)]);
  const removeKid = (i) => update("kidNames", draft.kidNames.filter((_, idx) => idx !== i));

  const effectiveUrl = draft.backendUrl || envBackendUrl;
  const effectiveSecret = draft.sharedSecret || (typeof window !== "undefined" && import.meta.env.VITE_SHARED_SECRET) || "";

  const testBackend = async () => {
    if (!effectiveUrl) return;
    setTestStatus("testing"); setTestError(null);
    const r = await pingBackend(effectiveUrl, effectiveSecret);
    if (r.ok) setTestStatus("ok");
    else { setTestStatus("fail"); setTestError(r.error); }
    setTimeout(() => { setTestStatus(null); setTestError(null); }, 6000);
  };

  const enablePush = async () => {
    const perm = await requestPushPermission();
    if (!perm.granted) { alert(perm.reason || "Permission denied"); return; }
    if (!draft.vapidPublicKey) { alert("Paste your VAPID public key first."); return; }
    const sub = await subscribeToPush(draft.vapidPublicKey);
    if (!sub.ok) { alert("Subscribe failed: " + sub.error); return; }
    const { registerPushSubscription } = await import("./sync.js");
    const r = await registerPushSubscription(effectiveUrl, sub.subscription, identity, effectiveSecret);
    if (!r.ok) { alert("Backend registration failed: " + r.error.message); return; }
    update("pushEnabled", true);
    setPushStatus(await getPushStatus());
    alert("Push notifications enabled.");
  };
  const disablePush = async () => {
    await unsubscribeFromPush();
    update("pushEnabled", false);
    setPushStatus(await getPushStatus());
  };
  const webcal = webcalUrl(effectiveUrl, effectiveSecret);

  return (
    <div>
      <div style={styles.formCard}>
        <h2 style={styles.sectionTitle}>People</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 24px" }}>Names show up in the assignee dropdown everywhere.</p>
        <div style={styles.formGrid}>
          <Field label="Parent 1 name"><input value={draft.parentNames[0]} onChange={(e) => update("parentNames", [e.target.value, draft.parentNames[1]])} style={styles.input} /></Field>
          <Field label="Parent 2 name"><input value={draft.parentNames[1]} onChange={(e) => update("parentNames", [draft.parentNames[0], e.target.value])} style={styles.input} /></Field>
          <Field label="Parent 1 email"><input type="email" value={draft.parentEmails[0]} onChange={(e) => update("parentEmails", [e.target.value, draft.parentEmails[1]])} placeholder="parent1@email.com" style={styles.input} /></Field>
          <Field label="Parent 2 email"><input type="email" value={draft.parentEmails[1]} onChange={(e) => update("parentEmails", [draft.parentEmails[0], e.target.value])} placeholder="parent2@email.com" style={styles.input} /></Field>
        </div>
        <div style={{ marginTop: 24 }}>
          <label style={styles.label}>Kids</label>
          {draft.kidNames.map((name, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input value={name} onChange={(e) => updateKid(i, e.target.value)} style={{ ...styles.input, flex: 1 }} />
              <button onClick={() => removeKid(i)} style={{ ...styles.iconBtn, color: "#A04848" }}><Trash2 size={14} /></button>
            </div>
          ))}
          <button onClick={addKid} style={styles.ghostBtn}><Plus size={14} /> Add kid</button>
        </div>
      </div>
      <div style={{ ...styles.formCard, marginTop: 24 }}>
        <h2 style={styles.sectionTitle}>This device</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 16px" }}>Used to attribute completions, streaks, and the leaderboard.</p>
        {identity ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 28 }}>{identity.emoji}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{identity.name}</div>
              <div style={{ fontSize: 12, color: "#8A8579", textTransform: "capitalize" }}>{identity.role}</div>
            </div>
            <button style={styles.ghostBtn} onClick={onResetIdentity}>Change</button>
          </div>
        ) : (<div style={{ color: "#8A8579" }}>No identity set - refresh to pick one.</div>)}
      </div>
      <div style={{ ...styles.formCard, marginTop: 24 }}>
        <h2 style={styles.sectionTitle}>Google Sheets backend</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 24px" }}>
          Paste your Apps Script Web App URL to enable Sunday emails, email-reply commands, AI features, and cross-device sync.
        </p>
        <Field label="Apps Script Web App URL" full>
          <input value={draft.backendUrl} onChange={(e) => update("backendUrl", e.target.value)}
            placeholder={envBackendUrl || "https://script.google.com/macros/s/AKfycb.../exec"} style={styles.input} />
          {envBackendUrl && !draft.backendUrl && (
            <div style={{ fontSize: 12, color: "#8A8579", marginTop: 4 }}>
              Using VITE_BACKEND_URL from build: {envBackendUrl}
            </div>
          )}
        </Field>
        <Field label="Shared secret (optional)" full>
          <input type="password" value={draft.sharedSecret} onChange={(e) => update("sharedSecret", e.target.value)}
            placeholder="Matches SHARED_SECRET in Apps Script properties" style={styles.input} />
        </Field>
        <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={testBackend} style={styles.ghostBtn} disabled={!effectiveUrl}>
            {testStatus === "testing" ? "Testing..." :
             testStatus === "ok"      ? "Connected" :
             testStatus === "fail"    ? "Failed" : "Test connection"}
          </button>
          {effectiveUrl && (<a href={effectiveUrl} target="_blank" rel="noreferrer" style={styles.linkBtn}>Open URL in new tab</a>)}
        </div>
        {testError && (
          <div style={{ ...styles.errorBanner, marginTop: 12 }}>
            <AlertCircle size={16} />
            <div>
              <strong>{testError.message}</strong>
              {testError.hint && <div style={{ fontSize: 12, color: "#6B5444", marginTop: 4 }}>{testError.hint}</div>}
            </div>
          </div>
        )}
      </div>
      <div style={{ ...styles.formCard, marginTop: 24 }}>
        <h2 style={styles.sectionTitle}>AI agent</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 16px" }}>
          Auto-categorises new tasks, parses "next Friday" into dates, and writes a weekly retrospective.
          The Anthropic API key lives in your Apps Script Script Properties - never in this browser.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <input type="checkbox" id="ai-toggle" checked={!!draft.aiEnabled}
            onChange={(e) => update("aiEnabled", e.target.checked)} />
          <label htmlFor="ai-toggle" style={{ fontSize: 14 }}>
            Enable AI features ({effectiveUrl ? "uses Apps Script proxy" : "requires backend URL above"})
          </label>
        </div>
        <div style={styles.infoBox}>
          <strong style={{ color: "#1B2C3A" }}>Setup steps</strong>
          <ol style={{ margin: "8px 0 0", paddingLeft: 20, lineHeight: 1.6 }}>
            <li>In your Apps Script project, open Project Settings &gt; Script Properties</li>
            <li>Add property <code>ANTHROPIC_API_KEY</code> with your key from console.anthropic.com</li>
            <li>Redeploy (Manage Deployments &gt; Edit &gt; Save)</li>
          </ol>
        </div>
      </div>
      <div style={{ ...styles.formCard, marginTop: 24 }}>
        <h2 style={styles.sectionTitle}>Push notifications</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 16px" }}>
          Sunday 7am summary + optional daily digest as a real push notification.
          Requires iOS 16.4+ (and the PWA must be installed) on iPhone.
        </p>
        {!pushStatus.supported && (
          <div style={{ color: "#8A8579", fontSize: 13 }}>This browser doesn't support push notifications.</div>
        )}
        {pushStatus.supported && (
          <>
            <Field label="VAPID public key" full>
              <input value={draft.vapidPublicKey} onChange={(e) => update("vapidPublicKey", e.target.value)}
                placeholder="Generated once, paste here (see DEPLOYMENT.md)" style={styles.input} />
            </Field>
            <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
              {pushStatus.subscribed
                ? <button onClick={disablePush} style={styles.ghostBtn}><BellOff size={14} /> Disable</button>
                : <button onClick={enablePush} style={styles.primaryBtn} disabled={!draft.vapidPublicKey || !effectiveUrl}>
                    <Bell size={14} /> Enable push
                  </button>}
              <div style={{ fontSize: 12, color: "#8A8579" }}>
                {pushStatus.subscribed ? "Subscribed on this device" :
                 pushStatus.permission === "denied" ? "Blocked - reset in browser settings" :
                 "Not subscribed"}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
              <input type="checkbox" id="digest-toggle" checked={!!draft.dailyDigestEnabled}
                onChange={(e) => update("dailyDigestEnabled", e.target.checked)} />
              <label htmlFor="digest-toggle" style={{ fontSize: 14 }}>
                Daily evening digest ("3 of 5 today")
              </label>
            </div>
            <div style={{ marginTop: 12 }}>
              <button style={styles.ghostBtn} onClick={() => {
                if (!("Notification" in window)) { alert("Notifications not supported."); return; }
                if (Notification.permission === "denied") { alert("Notifications blocked. Reset in browser settings."); return; }
                const show = () => new Notification("Family Ledger", {
                  body: "Test notification — push is working on this device!",
                  icon: "/icon-192.png",
                });
                if (Notification.permission === "granted") { show(); }
                else { Notification.requestPermission().then(p => { if (p === "granted") show(); else alert("Permission denied."); }); }
              }}><Bell size={14} /> Send test notification</button>
            </div>
          </>
        )}
      </div>
      <div style={{ ...styles.formCard, marginTop: 24 }}>
        <h2 style={styles.sectionTitle}>Live calendar subscription</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 16px" }}>
          Subscribe once - your calendar app polls the ledger and stays current. Beats re-exporting .ics every change.
        </p>
        {webcal ? (
          <>
            <Field label="webcal:// URL" full>
              <input readOnly value={webcal} style={styles.input} onClick={(e) => e.target.select()} />
            </Field>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <a href={webcal} style={styles.primaryBtn}>
                <CalendarDays size={14} /> Subscribe on this device
              </a>
              <button style={styles.ghostBtn}
                onClick={() => { navigator.clipboard.writeText(webcal).catch(() => {}); }}>
                <Copy size={14} /> Copy
              </button>
            </div>
          </>
        ) : (<div style={{ color: "#8A8579", fontSize: 13 }}>Set the backend URL above first.</div>)}
      </div>
      <div style={styles.formActions}>
        <button onClick={save} style={styles.primaryBtn}>{saved ? "Saved" : "Save settings"}</button>
      </div>
    </div>
  );
}

/* BRAINSTORM CHAT */
function BrainstormView({ household, aiCfg, categories, frequencies, assigneeOptions, onAddTask, onAddTasks }) {
  const [conversation, setConversation] = useState([
    { role: "assistant", content: "Hi! Tell me what you're planning - a project, an event, a new routine, a season change, anything - and I'll help turn it into a clean list of tasks for the ledger. What's on your mind?" },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState([]);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conversation, busy]);

  const send = async () => {
    if (!input.trim() || busy) return;
    if (!aiCfg.enabled) {
      setError("Enable the AI agent in Settings > AI agent first. (And make sure ANTHROPIC_API_KEY is in your Apps Script Script Properties.)");
      return;
    }
    setError(null);
    const userMsg = { role: "user", content: input.trim() };
    const next = [...conversation, userMsg];
    setConversation(next);
    setInput("");
    setBusy(true);

    const r = await brainstormTasks({
      backendUrl: aiCfg.backendUrl, sharedSecret: aiCfg.sharedSecret,
      conversation: next, household, categories, frequencies,
    });
    setBusy(false);

    if (!r || r.error) {
      setError((r && r.error && r.error.message) || "AI couldn't respond. Try again.");
      return;
    }
    const replyParts = [r.reply || "Got it."];
    if (r.followUp) replyParts.push(r.followUp);
    setConversation([...next, { role: "assistant", content: replyParts.join("\n\n") }]);

    if (Array.isArray(r.proposedTasks) && r.proposedTasks.length > 0) {
      const stamped = r.proposedTasks.map((t, i) => ({
        ...t,
        _id: "p_" + Date.now() + "_" + i,
        _selected: true,
      }));
      setProposed(prev => [...prev, ...stamped]);
    }
  };

  const toggleSelect = (id) => setProposed(ps => ps.map(p => p._id === id ? { ...p, _selected: !p._selected } : p));
  const updateProposed = (id, patch) => setProposed(ps => ps.map(p => p._id === id ? { ...p, ...patch } : p));
  const removeProposed = (id) => setProposed(ps => ps.filter(p => p._id !== id));
  const addSelected = () => {
    const toAdd = proposed.filter(p => p._selected);
    if (toAdd.length === 0) return;
const stripped = toAdd.map(p => {
      const { _id, _selected, reasoning, ...task } = p;
      return task;
    });
    if (typeof onAddTasks === "function") {
      onAddTasks(stripped);
    } else {
      // Fallback if parent didn't pass onAddTasks — adds will be lossy
      // (stale-closure bug), but at least one task lands.
      stripped.forEach(task => onAddTask(task));
    }
    setProposed(ps => ps.filter(p => !p._selected));
    setConversation(c => [...c, {
      role: "assistant",
      content: "Added " + toAdd.length + " task" + (toAdd.length === 1 ? "" : "s") + " to the ledger. Want to brainstorm more, or are we good?",
    }]);
  };

  return (
    <div>
      <div style={{ ...styles.sectionHeader, justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={styles.sectionTitle}>Brainstorm with AI</h2>
          <p style={{ color: "#6B6B6B", fontSize: 14, margin: "4px 0 0" }}>
            Describe what you're planning. I'll ask follow-ups and propose a task list with category, frequency, and priority pre-filled.
          </p>
        </div>
        {conversation.length > 1 && (
          <button style={styles.ghostBtn} onClick={() => {
            setConversation([{ role: "assistant", content: "Hi! Tell me what you're planning - a project, an event, a new routine, a season change, anything - and I'll help turn it into a clean list of tasks for the ledger. What's on your mind?" }]);
            setProposed([]);
            setError(null);
            setInput("");
          }}>
            <RefreshCw size={14} /> Clear
          </button>
        )}
      </div>

      <div style={styles.brainstormCard}>
        <div ref={scrollRef} style={styles.chatScroll}>
          {conversation.map((m, i) => (
            <div key={i} style={{ ...styles.chatBubble, ...(m.role === "user" ? styles.chatBubbleUser : styles.chatBubbleAi) }}>
              {m.role === "assistant" && <Sparkles size={12} color="#C9603C" style={{ marginRight: 6, marginTop: 3, flexShrink: 0 }} />}
              <div style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.content}</div>
            </div>
          ))}
          {busy && (
            <div style={{ ...styles.chatBubble, ...styles.chatBubbleAi }}>
              <Sparkles size={12} color="#C9603C" style={{ marginRight: 6, marginTop: 3 }} />
              <div style={{ flex: 1, fontStyle: "italic", color: "#8A8579" }}>thinking...</div>
            </div>
          )}
        </div>

        {error && (
          <div style={{ ...styles.errorBanner, margin: "12px 0 0" }}>
            <AlertCircle size={16} /> {error}
          </div>
        )}

        <div style={styles.chatInputRow}>
          <input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder='e.g. "We are moving into a new house next month"'
            style={{ ...styles.input, flex: 1 }} disabled={busy} />
          <button onClick={send} style={styles.primaryBtn} disabled={busy || !input.trim()}>
            <Send size={14} /> Send
          </button>
        </div>
      </div>

      {proposed.length > 0 && (
        <div style={{ ...styles.formCard, marginTop: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
            <h3 style={{ ...styles.categoryTitle, margin: 0 }}>
              Proposed tasks ({proposed.filter(p => p._selected).length} of {proposed.length} selected)
            </h3>
            <button style={styles.primaryBtn} onClick={addSelected} disabled={!proposed.some(p => p._selected)}>
              <Check size={14} /> Add selected to ledger
            </button>
          </div>
          {proposed.map(p => (
            <ProposedTaskCard key={p._id} task={p}
              categories={categories} frequencies={frequencies} assigneeOptions={assigneeOptions}
              onToggle={() => toggleSelect(p._id)}
              onChange={(patch) => updateProposed(p._id, patch)}
              onRemove={() => removeProposed(p._id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProposedTaskCard({ task, categories, frequencies, assigneeOptions, onToggle, onChange, onRemove }) {
  const [editing, setEditing] = useState(false);
  return (
    <div style={{ ...styles.proposedCard, opacity: task._selected ? 1 : 0.55 }}>
      <input type="checkbox" checked={!!task._selected} onChange={onToggle} style={{ marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {!editing ? (
          <>
            <div style={{ fontWeight: 600, color: "#1B2C3A", marginBottom: 4 }}>{task.title}</div>
            {task.details && <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 6 }}>{task.details}</div>}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "#8A8579" }}>
              <span>{task.assignedTo}</span>
              <span>· {task.frequency}</span>
              <span>· {task.priority}</span>
              <span>· {task.category}</span>
              {task.deadline && <span>· due {task.deadline}</span>}
            </div>
            {task.reasoning && (
              <div style={{ fontSize: 11, color: "#C9603C", marginTop: 6, fontStyle: "italic" }}>{task.reasoning}</div>
            )}
          </>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input value={task.title} onChange={(e) => onChange({ title: e.target.value })} style={{ ...styles.input, gridColumn: "1 / -1" }} />
            <textarea value={task.details || ""} onChange={(e) => onChange({ details: e.target.value })}
              rows={2} style={{ ...styles.input, gridColumn: "1 / -1", fontFamily: "inherit", resize: "vertical" }} />
            <select value={task.category} onChange={(e) => onChange({ category: e.target.value })} style={styles.input}>
              {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <select value={task.frequency} onChange={(e) => onChange({ frequency: e.target.value })} style={styles.input}>
              {frequencies.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <select value={task.assignedTo} onChange={(e) => onChange({ assignedTo: e.target.value })} style={styles.input}>
              {assigneeOptions.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={task.priority} onChange={(e) => onChange({ priority: e.target.value })} style={styles.input}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <input type="date" value={task.deadline || ""} onChange={(e) => onChange({ deadline: e.target.value || null })}
              style={{ ...styles.input, gridColumn: "1 / -1" }} />
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        <button style={styles.iconBtn} onClick={() => setEditing(e => !e)} title={editing ? "Done editing" : "Edit"}>
          {editing ? <Check size={14} /> : <Edit2 size={14} />}
        </button>
        <button style={{ ...styles.iconBtn, color: "#A04848" }} onClick={onRemove} title="Reject">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/* CELEBRATION */
function Celebration({ data }) {
  const isKid = !!data.isKid;
  return (
    <div style={styles.celebrationOverlay} key={data.key}>
      <div className={data.isMilestone ? "ledger-milestone" : "ledger-pop"} style={{
        ...styles.celebrationBox,
        ...(data.isMilestone ? styles.celebrationMilestone : {}),
        ...(isKid ? { background: "linear-gradient(135deg, #FAF7F2 0%, #E8F0E5 100%)", borderColor: "#5C7A3F" } : {}),
      }}>
        {isKid
          ? <div style={{ fontSize: data.isMilestone ? 44 : 32 }}>{(data.who && data.who.emoji) || "\u{1F389}"}</div>
          : <Flame size={data.isMilestone ? 36 : 24} color="#C9603C" strokeWidth={2.25} />}
        <div>
          <div style={{ fontFamily: "'Fraunces', serif", fontSize: data.isMilestone ? 28 : 20, fontWeight: 600, color: "#1B2C3A" }}>
            {isKid ? ("Nice one, " + (data.who && data.who.name) + "!") : (data.streak + " in a row")}
          </div>
          {isKid && (
            <div style={{ fontSize: 13, color: "#5C7A3F", fontWeight: 500, marginTop: 2 }}>
              That's {data.streak} {data.streak === 1 ? "time" : "in a row"}.
            </div>
          )}
          {data.isMilestone && !isKid && (
            <div style={{ fontSize: 13, color: "#C9603C", fontWeight: 500, marginTop: 2 }}>
              Milestone - keep the chain going.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* STYLES */
function FontStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,600&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');
      * { box-sizing: border-box; }
      body { margin: 0; }
      input, select, textarea, button { font-family: inherit; }
      input:focus, select:focus, textarea:focus { outline: 2px solid #C9603C !important; outline-offset: -2px; }
      button { cursor: pointer; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      select { appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%231B2C3A' stroke-width='2'><polyline points='6 9 12 15 18 9'/></svg>"); background-repeat: no-repeat; background-position: right 12px center; padding-right: 36px !important; }
      .ledger-checkbox:hover { transform: scale(1.08); transition: transform 0.15s; }
    `}</style>
  );
}

function KeyframeStyles() {
  return (
    <style>{`
      @keyframes ledger-streak-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
      .ledger-streak-pulse { animation: ledger-streak-pulse 2.2s ease-in-out infinite; }
      @keyframes ledger-pop-in {
        0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.7); }
        20%  { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
        40%  { transform: translate(-50%, -50%) scale(1); }
        80%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
      }
      .ledger-pop { animation: ledger-pop-in 1.5s ease-out forwards; }
      @keyframes ledger-milestone-in {
        0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.5) rotate(-8deg); }
        15%  { opacity: 1; transform: translate(-50%, -50%) scale(1.15) rotate(3deg); }
        30%  { transform: translate(-50%, -50%) scale(0.97) rotate(-1deg); }
        45%  { transform: translate(-50%, -50%) scale(1.03) rotate(0deg); }
        60%  { transform: translate(-50%, -50%) scale(1); }
        85%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
      }
      .ledger-milestone { animation: ledger-milestone-in 3s ease-out forwards; }
    `}</style>
  );
}

const styles = {
  shell: { minHeight: "100vh", backgroundColor: "#FAF7F2", fontFamily: "'DM Sans', system-ui, sans-serif", color: "#1B2C3A", position: "relative", paddingBottom: 80 },
  grain: { position: "fixed", inset: 0, pointerEvents: "none", opacity: 0.4, backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 0.1 0 0 0 0 0.1 0 0 0 0 0.1 0 0 0 0.06 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")" },
  loadingShell: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#FAF7F2" },
  container: { maxWidth: 1100, margin: "0 auto", padding: "40px 32px", position: "relative", zIndex: 1 },
  header: { marginBottom: 32 },
  headerTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24, marginBottom: 28, flexWrap: "wrap" },
  eyebrow: { fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "#8A8579", fontWeight: 500, marginBottom: 8 },
  title: { fontFamily: "'Fraunces', serif", fontWeight: 500, fontSize: "clamp(36px, 5vw, 56px)", lineHeight: 1.05, letterSpacing: "-0.02em", margin: 0 },
  scoreCard: { backgroundColor: "#1B2C3A", color: "#FAF7F2", padding: "16px 24px", borderRadius: 4, textAlign: "center", minWidth: 180 },
  scoreLabel: { fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", opacity: 0.7, marginBottom: 4 },
  scoreValue: { fontFamily: "'Fraunces', serif", fontSize: 36, fontWeight: 500, lineHeight: 1 },
  scoreDivider: { opacity: 0.4, margin: "0 4px" },
  scoreTotal: { opacity: 0.6 },
  scoreProgressTrack: { height: 3, backgroundColor: "rgba(250,247,242,0.15)", borderRadius: 2, marginTop: 10, overflow: "hidden" },
  scoreProgressFill: { height: "100%", backgroundColor: "#C9603C", transition: "width 0.4s ease" },
  scoreSub: { fontSize: 11, opacity: 0.65, marginTop: 6, letterSpacing: "0.05em" },
  nav: { display: "flex", gap: 4, borderBottom: "1px solid #E5DFD3", paddingBottom: 0, flexWrap: "wrap" },
  navBtn: { display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", border: "none", background: "transparent", fontSize: 14, color: "#6B6B6B", borderBottom: "2px solid transparent", marginBottom: "-1px", fontWeight: 500, transition: "color 0.15s" },
  navBtnActive: { color: "#1B2C3A", borderBottomColor: "#C9603C" },
  toggleGroup: { display: "flex", border: "1px solid #D9D2C4", borderRadius: 3, overflow: "hidden" },
  toggleBtn: { padding: "8px 14px", border: "none", background: "transparent", fontSize: 13, color: "#6B6B6B", fontWeight: 500 },
  toggleBtnActive: { backgroundColor: "#1B2C3A", color: "#FAF7F2" },
  sectionHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, gap: 16, flexWrap: "wrap" },
  sectionTitle: { fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 500, margin: 0, letterSpacing: "-0.01em" },
  quickAdd: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, padding: 14, marginBottom: 28, transition: "all 0.15s" },
  quickAddExpanded: { borderColor: "#C9603C", boxShadow: "0 0 0 3px rgba(201,96,60,0.08)" },
  quickAddRow: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  quickAddInput: { flex: 1, border: "none", outline: "none", fontSize: 15, padding: "6px 0", background: "transparent", color: "#1B2C3A", minWidth: 200 },
  quickAddOptions: { display: "flex", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid #F0EAE0", flexWrap: "wrap" },
  leaderboardCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, padding: 16, marginBottom: 28 },
  categorySection: { marginBottom: 36 },
  categoryHeader: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid #E5DFD3" },
  categoryDot: { width: 10, height: 10, borderRadius: "50%" },
  categoryTitle: { fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 500, margin: 0, flex: 1, textTransform: "capitalize" },
  categoryCount: { fontSize: 12, color: "#8A8579", fontVariantNumeric: "tabular-nums" },
  taskGrid: { display: "flex", flexDirection: "column", gap: 8 },
  taskCard: { display: "flex", alignItems: "flex-start", gap: 14, padding: "16px 18px", backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderLeftStyle: "solid", borderRadius: 4, transition: "all 0.15s", position: "relative" },
  taskCardDone: { backgroundColor: "#F2EDE4", opacity: 0.75 },
  checkbox: { width: 22, height: 22, border: "1.5px solid", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2, transition: "all 0.15s", padding: 0, background: "transparent" },
  taskTitleRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" },
  taskTitle: { fontSize: 15, fontWeight: 500, margin: 0, lineHeight: 1.3 },
  priorityHigh: { fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "#C9603C", fontWeight: 600, backgroundColor: "#FAEFEA", padding: "2px 8px", borderRadius: 2 },
  taskDetails: { fontSize: 13, color: "#6B6B6B", margin: "4px 0 8px", lineHeight: 1.5 },
  taskMeta: { display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: "#8A8579" },
  metaChip: { display: "inline-flex", alignItems: "center", gap: 4 },
  streakBadge: { display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", backgroundColor: "#FAEFEA", color: "#C9603C", borderRadius: 999, fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  primaryBtn: { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 18px", backgroundColor: "#1B2C3A", color: "#FAF7F2", border: "none", borderRadius: 3, fontSize: 14, fontWeight: 500, transition: "background 0.15s", textDecoration: "none" },
  ghostBtn: { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px", backgroundColor: "transparent", color: "#1B2C3A", border: "1px solid #C9C2B5", borderRadius: 3, fontSize: 13, fontWeight: 500, textDecoration: "none" },
  iconBtn: { width: 30, height: 30, border: "none", backgroundColor: "transparent", color: "#6B6B6B", borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s", padding: 0 },
  linkBtn: { background: "transparent", border: "none", color: "#C9603C", fontWeight: 500, cursor: "pointer", padding: "4px 8px", fontSize: 13, textDecoration: "underline" },
  snoozeMenu: { position: "absolute", top: 36, right: 0, backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, boxShadow: "0 4px 16px rgba(27,44,58,0.08)", padding: 8, minWidth: 200, zIndex: 10 },
  snoozeTitle: { fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#8A8579", fontWeight: 600, padding: "4px 8px 8px" },
  snoozeItem: { display: "block", width: "100%", padding: "8px 10px", border: "none", background: "transparent", textAlign: "left", fontSize: 13, color: "#1B2C3A", borderRadius: 3 },
  snoozeCustom: { display: "flex", gap: 4, padding: "8px 4px 4px", borderTop: "1px solid #F0EAE0", marginTop: 4 },
  snoozedPill: { display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", backgroundColor: "#F2EDE4", color: "#8A8579", borderRadius: 999, fontSize: 11, border: "none", cursor: "pointer" },
  filterBar: { display: "flex", gap: 24, marginBottom: 16, padding: "12px 16px", backgroundColor: "#F2EDE4", borderRadius: 4, flexWrap: "wrap" },
  filterGroup: { display: "flex", alignItems: "center", gap: 8 },
  filterLabel: { fontSize: 12, color: "#6B6B6B", fontWeight: 500 },
  select: { padding: "6px 32px 6px 10px", border: "1px solid #D9D2C4", borderRadius: 3, backgroundColor: "#FFFFFF", fontSize: 13, color: "#1B2C3A" },
  table: { width: "100%", borderCollapse: "collapse", backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, overflow: "hidden" },
  tableHeadRow: { backgroundColor: "#F2EDE4" },
  th: { textAlign: "left", padding: "10px 8px", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B6B6B", fontWeight: 600, borderBottom: "1px solid #E5DFD3", whiteSpace: "nowrap" },
  tableRow: { borderBottom: "1px solid #F0EAE0" },
  td: { padding: "10px 8px", fontSize: 13, color: "#1B2C3A", verticalAlign: "top" },
  categoryPill: { display: "inline-block", padding: "2px 10px", border: "1px solid", borderRadius: 999, fontSize: 11, fontWeight: 500, whiteSpace: "nowrap" },
  priorityPill: { display: "inline-block", padding: "2px 10px", backgroundColor: "#F2EDE4", color: "#6B6B6B", borderRadius: 999, fontSize: 11, textTransform: "capitalize" },
  priorityPillHigh: { backgroundColor: "#FAEFEA", color: "#C9603C" },
  priorityPillLow: { backgroundColor: "#F2EDE4", color: "#8A8579" },
  formCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, padding: 32 },
  formHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 },
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 },
  label: { display: "block", fontSize: 12, fontWeight: 500, color: "#6B6B6B", marginBottom: 6, letterSpacing: "0.02em" },
  input: { width: "100%", padding: "10px 12px", border: "1px solid #D9D2C4", borderRadius: 3, backgroundColor: "#FFFFFF", fontSize: 14, color: "#1B2C3A" },
  formActions: { display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 28, paddingTop: 24, borderTop: "1px solid #E5DFD3" },
  emailCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, overflow: "hidden" },
  emailMeta: { padding: "16px 24px", borderBottom: "1px solid #E5DFD3", backgroundColor: "#F2EDE4", display: "flex", flexDirection: "column", gap: 6, fontSize: 13 },
  emailMetaLabel: { fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "#8A8579", fontWeight: 600, marginRight: 12, minWidth: 60, display: "inline-block" },
  emailBody: { padding: 24, margin: 0, fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 14, lineHeight: 1.65, color: "#1B2C3A", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  emptyState: { textAlign: "center", padding: "80px 20px", backgroundColor: "#FFFFFF", border: "1px dashed #D9D2C4", borderRadius: 4 },
  errorBanner: { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", backgroundColor: "#FAEFEA", color: "#A04848", borderRadius: 3, fontSize: 13, marginBottom: 16 },
  conflictBanner: { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", backgroundColor: "#FAF1E0", color: "#8B6F2F", borderRadius: 3, fontSize: 13, marginBottom: 16, flexWrap: "wrap" },
  updateBanner: { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", backgroundColor: "#E8F0E5", color: "#3F5C25", borderRadius: 3, fontSize: 13, marginBottom: 16 },
  infoBox: { marginTop: 24, padding: 20, backgroundColor: "#F2EDE4", borderLeft: "3px solid #C9603C", borderRadius: 3, fontSize: 13, color: "#6B6B6B" },
  syncErrorPopover: { position: "absolute", top: 22, left: 12, backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, boxShadow: "0 4px 16px rgba(27,44,58,0.12)", padding: 12, minWidth: 260, zIndex: 20, fontSize: 12, color: "#1B2C3A" },
  insightGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 28 },
  insightCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, padding: 18 },
  insightLabel: { fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#8A8579", fontWeight: 500, marginBottom: 8 },
  insightValue: { fontFamily: "'Fraunces', serif", fontSize: 32, fontWeight: 500, lineHeight: 1, color: "#1B2C3A" },
  insightSub: { fontSize: 12, color: "#8A8579", marginTop: 6 },
  retroCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderLeft: "3px solid #C9603C", borderRadius: 4, padding: 24, marginBottom: 24 },
  retroSection: { fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#8A8579", fontWeight: 600, marginBottom: 6 },
  retroBullet: { fontSize: 14, color: "#1B2C3A", lineHeight: 1.5, marginBottom: 4 },
  retroSuggestion: { display: "flex", alignItems: "center", gap: 6, padding: 12, backgroundColor: "#FAEFEA", borderRadius: 3, color: "#1B2C3A", fontSize: 14, marginTop: 12 },
  brainstormCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, padding: 18, display: "flex", flexDirection: "column", gap: 12 },
  chatScroll: { maxHeight: 480, minHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: 4 },
  chatBubble: { display: "flex", alignItems: "flex-start", padding: "10px 14px", borderRadius: 12, maxWidth: "85%", fontSize: 14, lineHeight: 1.5 },
  chatBubbleUser: { alignSelf: "flex-end", backgroundColor: "#1B2C3A", color: "#FAF7F2", borderBottomRightRadius: 4 },
  chatBubbleAi:   { alignSelf: "flex-start", backgroundColor: "#F2EDE4", color: "#1B2C3A", borderBottomLeftRadius: 4 },
  chatInputRow: { display: "flex", gap: 8, alignItems: "stretch", paddingTop: 12, borderTop: "1px solid #F0EAE0" },
  proposedCard: { display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", borderTop: "1px solid #F0EAE0", transition: "opacity 0.15s" },

  celebrationOverlay: { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" },
  celebrationBox: { position: "absolute", left: "50%", top: "50%", display: "flex", alignItems: "center", gap: 16, padding: "20px 28px", backgroundColor: "#FAF7F2", border: "2px solid #C9603C", borderRadius: 8, boxShadow: "0 20px 50px rgba(27,44,58,0.18)" },
  celebrationMilestone: { padding: "28px 40px", background: "linear-gradient(135deg, #FAF7F2 0%, #FAEFEA 100%)" },
};
/* The Family Ledger v2 - see ONBOARDING.md */
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { storage } from "./storage.js";
import {
  pingBackend, loadFromBackend, syncToBackend, webcalUrl, formatDebugInfo,
} from "./sync.js";
import {
  loadIdentity, saveIdentity, clearIdentity, makeIdentity,
  weeklyLeaderboard, personalDailyStreak,
} from "./identity.js";
import {
  suggestTaskMetadata, weeklyRetrospective, staleTaskAdvice, parseDeadline, brainstormTasks,
} from "./ai.js";
import {
  loadEventLog, appendEvent, rerankByUsage,
  findStaleTasks, detectSnoozePatterns, throughputTrend, detectRepeatQuickAdds,
} from "./insights.js";
import {
  isPushSupported, requestPushPermission, subscribeToPush,
  unsubscribeFromPush, getPushStatus,
} from "./push.js";
import {
  Check, Plus, Calendar, Mail, List, Home, Trash2, Edit2, X, Copy,
  AlertCircle, Users, Briefcase, Heart, DollarSign, Baby, Wrench,
  Sparkles, Filter, Flame, Zap, Clock, Download,
  CalendarDays, ReceiptText, PartyPopper, ClipboardList,
  Settings as SettingsIcon, Cloud, CloudOff, Bell, BellOff,
  Wand2, TrendingUp, TrendingDown, Trophy, RefreshCw, ChevronDown,
  Brain, Lightbulb, ArrowRight, MessageCircle, Send,
} from "lucide-react";

/* CONSTANTS */
const STORAGE_KEY  = "family_ledger_v3";
const SETTINGS_KEY = "family_ledger_settings_v3";

const CATEGORIES = [
  { id: "house-care",   label: "House Care",      icon: Wrench,        color: "#4A6B8A" },
  { id: "life-admin",   label: "Life Admin",      icon: ClipboardList, color: "#8B6F2F" },
  { id: "kids",         label: "Kids Activities", icon: Baby,          color: "#A04848" },
  { id: "bills",        label: "Bills",           icon: ReceiptText,   color: "#5C7A3F" },
  { id: "events",       label: "Events",          icon: PartyPopper,   color: "#C9603C" },
  { id: "business",     label: "Business Tasks",  icon: Briefcase,     color: "#4F5D5C" },
  { id: "finance",      label: "Finance",         icon: DollarSign,    color: "#7A5C3F" },
  { id: "health",       label: "Health",          icon: Heart,         color: "#7A4A6B" },
  { id: "family",       label: "Family",          icon: Users,         color: "#B5832E" },
  { id: "other",        label: "Other",           icon: Sparkles,      color: "#6B6B6B" },
];
const FREQUENCIES = [
  { id: "daily",     label: "Daily",         days: 1   },
  { id: "weekly",    label: "Weekly",        days: 7   },
  { id: "biweekly",  label: "Every 2 weeks", days: 14  },
  { id: "monthly",   label: "Monthly",       days: 30  },
  { id: "quarterly", label: "Quarterly",     days: 91  },
  { id: "annual",    label: "Annual",        days: 365 },
  { id: "once",      label: "One time",      days: null },
];
const PRIORITIES = [
  { id: "high",   label: "High",   order: 0, color: "#C9603C" },
  { id: "medium", label: "Medium", order: 1, color: "#8A8579" },
  { id: "low",    label: "Low",    order: 2, color: "#B5B0A4" },
];
const MILESTONES = [3, 5, 10, 25, 52, 100];
const ENV_BACKEND_URL   = (import.meta.env && import.meta.env.VITE_BACKEND_URL)   || "";
const ENV_SHARED_SECRET = (import.meta.env && import.meta.env.VITE_SHARED_SECRET) || "";

/* DATE HELPERS */
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function toISO(d)      { return new Date(d).toISOString().split("T")[0]; }
function getWeekRange(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - day);
  sunday.setHours(0,0,0,0);
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() + 6);
  saturday.setHours(23,59,59,999);
  return { start: sunday, end: saturday };
}
function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function daysUntil(iso) {
  if (!iso) return null;
  const d = startOfDay(iso);
  const t = startOfDay(new Date());
  return Math.round((d - t) / 86400000);
}

/* TASK LOGIC */
function isSnoozed(task) {
  if (!task.snoozedUntil) return false;
  return startOfDay(task.snoozedUntil) > startOfDay(new Date());
}
function isDueThisWeek(task) {
  if (isSnoozed(task)) return false;
  const { end } = getWeekRange();
  const freq = FREQUENCIES.find(f => f.id === task.frequency);
  if (task.frequency === "once") {
    if (!task.deadline) return true;
    return new Date(task.deadline) <= end;
  }
  if (task.frequency === "daily" || task.frequency === "weekly") return true;
  if (!task.lastCompleted) return true;
  const last = new Date(task.lastCompleted);
  const nextDue = new Date(last.getTime() + freq.days * 86400000);
  return nextDue <= end;
}
function calcStreak(task) {
  if (task.frequency === "once") return 0;
  const history = (task.completionHistory || []).map(d => startOfDay(d).getTime());
  if (history.length === 0) return 0;
  const set = new Set(history);
  const freq = FREQUENCIES.find(f => f.id === task.frequency);
  if (task.frequency === "daily") {
    let streak = 0;
    const cursor = startOfDay(new Date());
    if (!set.has(cursor.getTime())) cursor.setDate(cursor.getDate() - 1);
    while (set.has(cursor.getTime())) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }
  const today = startOfDay(new Date()).getTime();
  let streak = 0;
  let windowEnd = today + 86400000;
  let windowStart = windowEnd - freq.days * 86400000;
  const firstDone = history.some(t => t >= windowStart && t < windowEnd);
  if (!firstDone) {
    windowEnd = windowStart;
    windowStart = windowEnd - freq.days * 86400000;
  }
  while (history.some(t => t >= windowStart && t < windowEnd)) {
    streak++;
    windowEnd = windowStart;
    windowStart = windowEnd - freq.days * 86400000;
    if (streak > 500) break;
  }
  return streak;
}

/* ICS */
function generateICS(tasks, reminderMinutes = 60) {
  const lines = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//The Family Ledger//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH"];
  const freqMap = { daily:"DAILY", weekly:"WEEKLY", biweekly:"WEEKLY;INTERVAL=2", monthly:"MONTHLY", quarterly:"MONTHLY;INTERVAL=3", annual:"YEARLY" };
  const fmtDT = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return d.getUTCFullYear() + p(d.getUTCMonth()+1) + p(d.getUTCDate()) +
           "T" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + "00Z";
  };
  const esc = (s) => (s || "").replace(/[\\,;]/g, "\\$&").replace(/\n/g, "\\n");
  tasks.forEach(task => {
    const baseDate = task.deadline ? new Date(task.deadline) : getWeekRange().end;
    const start = new Date(baseDate); start.setHours(9,0,0,0);
    const end = new Date(start); end.setMinutes(start.getMinutes() + 30);
    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + task.id + "@family-ledger");
    lines.push("DTSTAMP:" + fmtDT(new Date()));
    lines.push("DTSTART:" + fmtDT(start));
    lines.push("DTEND:" + fmtDT(end));
    lines.push("SUMMARY:" + esc(task.title));
    let desc = task.details || "";
    desc += "\n\nAssigned: " + task.assignedTo;
    desc += "\nFrequency: " + (FREQUENCIES.find(f => f.id === task.frequency) || {}).label;
    desc += "\nPriority: " + task.priority;
    lines.push("DESCRIPTION:" + esc(desc));
    if (task.frequency !== "once" && freqMap[task.frequency]) {
      lines.push("RRULE:FREQ=" + freqMap[task.frequency]);
    }
    lines.push("BEGIN:VALARM");
    lines.push("TRIGGER:-PT" + reminderMinutes + "M");
    lines.push("ACTION:DISPLAY");
    lines.push("DESCRIPTION:" + esc(task.title));
    lines.push("END:VALARM");
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
function downloadICS(tasks) {
  const blob = new Blob([generateICS(tasks)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "family-ledger-" + toISO(new Date()) + ".ics";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* SEED + DEFAULTS + MIGRATE */
function seedTasks() {
  const today = new Date();
  const inDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return toISO(d); };
  const base = { lastCompleted: null, completionHistory: [], completionLog: [], snoozedUntil: null, lastModified: Date.now() };
  return [
    { ...base, id: "seed_1", title: "Review weekly budget", details: "Reconcile joint checking, review credit card spend.", category: "finance", assignedTo: "Both Parents", frequency: "weekly", deadline: inDays(6), priority: "high", createdAt: Date.now() },
    { ...base, id: "seed_2", title: "Pay mortgage", details: "Auto-pay set, verify it cleared.", category: "bills", assignedTo: "Parent 1", frequency: "monthly", deadline: null, priority: "high", createdAt: Date.now() },
    { ...base, id: "seed_3", title: "Pack school lunches", details: "Prep ingredients Sunday night.", category: "kids", assignedTo: "Anyone", frequency: "daily", deadline: null, priority: "medium", createdAt: Date.now() },
    { ...base, id: "seed_4", title: "Change HVAC filter", details: "20x25x1 MERV 11. Spares in garage shelf.", category: "house-care", assignedTo: "Parent 2", frequency: "monthly", deadline: null, priority: "medium", createdAt: Date.now() },
    { ...base, id: "seed_5", title: "Family meeting", details: "Sunday 6pm. Calendar review, wins of the week.", category: "family", assignedTo: "Family", frequency: "weekly", deadline: null, priority: "high", createdAt: Date.now() },
    { ...base, id: "seed_6", title: "Renew car registration", details: "Tabs expire end of month. State portal.", category: "life-admin", assignedTo: "Parent 1", frequency: "annual", deadline: inDays(21), priority: "high", createdAt: Date.now() },
    { ...base, id: "seed_7", title: "Birthday party planning", details: "Kid's 8th - venue, invites, cake, RSVPs.", category: "events", assignedTo: "Both Parents", frequency: "once", deadline: inDays(30), priority: "medium", createdAt: Date.now() },
  ];
}
const DEFAULT_SETTINGS = {
  parentNames: ["Parent 1", "Parent 2"],
  kidNames: ["Kid 1"],
  parentEmails: ["", ""],
  backendUrl: "",
  sharedSecret: "",
  aiEnabled: true,
  vapidPublicKey: "",
  pushEnabled: false,
  dailyDigestEnabled: false,
};
function migrate(arr) {
  return (arr || []).map(t => {
    const next = {
      snoozedUntil: null, completionHistory: [], completionLog: [],
      lastModified: t.lastModified || Date.now(),
      createdAt: t.createdAt || Date.now(),
      ...t,
    };
    if ((!next.completionLog || next.completionLog.length === 0) && (next.completionHistory || []).length > 0) {
      next.completionLog = next.completionHistory.map(d => ({ date: d, by: "Family" }));
    }
    return next;
  });
}

/* ROOT */
export default function FamilyLedger() {
  const [tasks, setTasks] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [identity, setIdentity] = useState(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [view, setView] = useState("dashboard");
  const [groupBy, setGroupBy] = useState("category");
  const [editingTask, setEditingTask] = useState(null);
  const [filterCategory, setFilterCategory] = useState("all");
  const [filterAssignee, setFilterAssignee] = useState("all");
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState(null);
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncError, setSyncError] = useState(null);
  const [conflictBanner, setConflictBanner] = useState(null);
  const [celebration, setCelebration] = useState(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [events, setEvents] = useState([]);
  const saveTimeoutRef = useRef(null);
  const remoteSnapshotRef = useRef(null);

  const effectiveBackendUrl   = settings.backendUrl   || ENV_BACKEND_URL;
  const effectiveSharedSecret = settings.sharedSecret || ENV_SHARED_SECRET;

  useEffect(() => {
    (async () => {
      try {
        let s = DEFAULT_SETTINGS;
        try {
          const sRes = await storage.get(SETTINGS_KEY);
          if (sRes && sRes.value) s = { ...DEFAULT_SETTINGS, ...JSON.parse(sRes.value) };
        } catch (e) {}
        setSettings(s);
        const id = await loadIdentity();
        setIdentity(id);
        setIdentityReady(true);
        try { setEvents(await loadEventLog()); } catch (e) {}
        const backendUrl = s.backendUrl || ENV_BACKEND_URL;
        const sharedSecret = s.sharedSecret || ENV_SHARED_SECRET;
        if (backendUrl) {
          setSyncStatus("syncing");
          const r = await loadFromBackend(backendUrl, sharedSecret);
          if (r.ok && r.data && r.data.tasks) {
            // First-run auto-persist: if backendUrl/sharedSecret are currently
            // coming from the build-time env vars (not user-saved), promote
            // them to IndexedDB now that we've confirmed the URL works. Without
            // this, users would have to manually open Settings + Save on every
            // new device for cross-device sync to function.
            if ((!s.backendUrl && ENV_BACKEND_URL) || (!s.sharedSecret && ENV_SHARED_SECRET)) {
              s = {
                ...s,
                backendUrl:   s.backendUrl   || ENV_BACKEND_URL,
                sharedSecret: s.sharedSecret || ENV_SHARED_SECRET,
              };
              setSettings(s);
              try { await storage.set(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
            }
            const migrated = migrate(r.data.tasks);
            setTasks(migrated);
            remoteSnapshotRef.current = migrated;
            setSyncStatus("ok");
            setSyncError(null);
            await persistLocal(migrated);
            // Sync household roster from the Sheet (source of truth for names/emails).
            if (r.data.settings) {
              const rs = r.data.settings;
              const hasRoster = (rs.parentNames && rs.parentNames.length > 0)
                             || (rs.kidNames && rs.kidNames.length > 0)
                             || (rs.parentEmails && rs.parentEmails.length > 0);
              if (hasRoster) {
                const merged = {
                  ...s,
                  parentNames:  rs.parentNames  && rs.parentNames.length  > 0 ? rs.parentNames  : s.parentNames,
                  kidNames:     rs.kidNames     && rs.kidNames.length     > 0 ? rs.kidNames     : s.kidNames,
                  parentEmails: rs.parentEmails && rs.parentEmails.length > 0 ? rs.parentEmails : s.parentEmails,
                };
                setSettings(merged);
                try { await storage.set(SETTINGS_KEY, JSON.stringify(merged)); } catch (e) {}
              }
            }
            setLoading(false);
            return;
          }
          if (!r.ok) { setSyncStatus("error"); setSyncError(r.error); }
        }
        try {
          const res = await storage.get(STORAGE_KEY);
          if (res && res.value) {
            const data = JSON.parse(res.value);
            setTasks(migrate(data.tasks || []));
          } else {
            const seeded = seedTasks();
            setTasks(seeded);
            await persistLocal(seeded);
          }
        } catch (e) {
          const seeded = seedTasks();
          setTasks(seeded);
          try { await persistLocal(seeded); } catch (e2) {}
        }
      } catch (e) {
        setStorageError("Couldn't load. Changes may not persist. " + (e.message || ""));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const onUpdate = () => setUpdateReady(true);
    window.addEventListener("ledger:update-ready", onUpdate);
    return () => window.removeEventListener("ledger:update-ready", onUpdate);
  }, []);

  useEffect(() => {
    if (!effectiveBackendUrl) return;
    const interval = setInterval(async () => {
      const r = await loadFromBackend(effectiveBackendUrl, effectiveSharedSecret);
      if (!r.ok || !r.data || !r.data.tasks) return;
      const remote = migrate(r.data.tasks);
      const localById = new Map(tasks.map(t => [t.id, t]));
      const conflicts = remote.filter(rt => {
        const lt = localById.get(rt.id);
        return lt && (rt.lastModified || 0) > (lt.lastModified || 0)
            && JSON.stringify(rt) !== JSON.stringify(lt);
      });
      if (conflicts.length > 0) {
        setConflictBanner({ remoteCount: conflicts.length, remote });
      } else {
        if (JSON.stringify(remote.map(r => r.id).sort()) !==
            JSON.stringify(tasks.map(t => t.id).sort())) {
          setTasks(remote);
          remoteSnapshotRef.current = remote;
          await persistLocal(remote);
        }
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [effectiveBackendUrl, effectiveSharedSecret, tasks]);

  async function persistLocal(nextTasks) {
    try { await storage.set(STORAGE_KEY, JSON.stringify({ tasks: nextTasks })); }
    catch (e) { setStorageError("Local save failed: " + e.message); }
  }

  const persist = useCallback((nextTasks) => {
    setTasks(nextTasks);
    persistLocal(nextTasks);
    if (effectiveBackendUrl) {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      setSyncStatus("syncing");
      saveTimeoutRef.current = setTimeout(async () => {
        const r = await syncToBackend(effectiveBackendUrl, { tasks: nextTasks }, effectiveSharedSecret);
        if (r.ok) { setSyncStatus("ok"); setSyncError(null); remoteSnapshotRef.current = nextTasks; }
        else { setSyncStatus("error"); setSyncError(r.error); }
      }, 800);
    }
  }, [effectiveBackendUrl, effectiveSharedSecret]);

  async function persistSettings(next) {
    setSettings(next);
    try { await storage.set(SETTINGS_KEY, JSON.stringify(next)); }
    catch (e) { setStorageError("Settings save failed: " + e.message); }
  }

  function upsertTask(taskData) {
    let next;
    const stamp = Date.now();
    if (taskData.id && tasks.find(t => t.id === taskData.id)) {
      next = tasks.map(t => t.id === taskData.id ? { ...t, ...taskData, lastModified: stamp } : t);
    } else {
      const created = {
        completionHistory: [], completionLog: [], snoozedUntil: null, lastCompleted: null,
        ...taskData,
        id: taskData.id || "task_" + Date.now() + "_" + Math.random().toString(36).slice(2,7),
        createdAt: stamp, lastModified: stamp,
      };
      next = [...tasks, created];
      appendEvent({ kind: "quick-add", taskId: created.id, meta: {
        title: created.title, category: created.category,
        frequency: created.frequency, assignedTo: created.assignedTo,
      } }).then(loadEventLog).then(setEvents);
    }
    persist(next);
    setEditingTask(null);
    setView("dashboard");
  }

  // Batch version of upsertTask. Use this when adding multiple tasks from
  // a single user action (e.g. Brainstorm "Add selected to ledger"). Calling
  // upsertTask in a loop hits a stale-closure bug because each iteration
  // reads the same tasks snapshot and React batches the setState calls,
  // so only the last task survives. This function builds one next array
  // with all new tasks and calls persist() exactly once.
  function upsertTasks(tasksArray) {
    if (!Array.isArray(tasksArray) || tasksArray.length === 0) return;
    const stamp = Date.now();
    const created = tasksArray.map((td, i) => ({
      completionHistory: [], completionLog: [], snoozedUntil: null, lastCompleted: null,
      ...td,
      id: td.id || "task_" + stamp + "_" + i + "_" + Math.random().toString(36).slice(2,5),
      createdAt: stamp, lastModified: stamp,
    }));
    const next = [...tasks, ...created];
    Promise.all(created.map(c => appendEvent({
      kind: "quick-add", taskId: c.id, meta: {
        title: c.title, category: c.category,
        frequency: c.frequency, assignedTo: c.assignedTo,
      },
    }))).then(loadEventLog).then(setEvents).catch(() => {});
    persist(next);
  }

  function deleteTask(id) {
    appendEvent({ kind: "delete", taskId: id }).then(loadEventLog).then(setEvents);
    persist(tasks.filter(t => t.id !== id));
  }

  function toggleComplete(taskId) {
    const today = toISO(new Date());
    const by = (identity && identity.name) || "Family";
    const next = tasks.map(t => {
      if (t.id !== taskId) return t;
      const history = t.completionHistory || [];
      const log = t.completionLog || [];
      const wasDoneToday = history.includes(today);
      if (wasDoneToday) {
        const filtered = history.filter(d => d !== today);
        const filteredLog = log.filter(e => e.date !== today);
        return { ...t, completionHistory: filtered, completionLog: filteredLog,
          lastCompleted: filtered.sort().pop() || null, lastModified: Date.now() };
      }
      const newHistory = [...history, today].sort();
      const newLog = [...log, { date: today, by }];
      const oldStreak = calcStreak(t);
      const newStreak = calcStreak({ ...t, completionHistory: newHistory });
      if (newStreak > oldStreak && newStreak >= 2) {
        triggerCelebration(t.title, newStreak, identity);
      }
      appendEvent({ kind: "complete", taskId: t.id, meta: { by } }).then(loadEventLog).then(setEvents);
      return { ...t, completionHistory: newHistory, completionLog: newLog,
        lastCompleted: today, lastModified: Date.now() };
    });
    persist(next);
  }

  function snoozeTask(taskId, dateISO) {
    const daysOut = Math.max(0, Math.round((new Date(dateISO) - new Date()) / 86400000));
    appendEvent({ kind: "snooze", taskId, meta: { daysOut } }).then(loadEventLog).then(setEvents);
    persist(tasks.map(t => t.id === taskId ? { ...t, snoozedUntil: dateISO, lastModified: Date.now() } : t));
  }
  function unsnoozeTask(taskId) {
    persist(tasks.map(t => t.id === taskId ? { ...t, snoozedUntil: null, lastModified: Date.now() } : t));
  }
  function triggerCelebration(title, streak, who) {
    const isMilestone = MILESTONES.includes(streak);
    const isKid = who && who.role === "kid";
    setCelebration({ title, streak, isMilestone, isKid, who, key: Date.now() });
    setTimeout(() => setCelebration(null), isMilestone ? 3000 : 1500);
  }
  function adoptRemote() {
    if (!conflictBanner || !conflictBanner.remote) return;
    setTasks(conflictBanner.remote);
    persistLocal(conflictBanner.remote);
    remoteSnapshotRef.current = conflictBanner.remote;
    setConflictBanner(null);
  }
  function keepLocalOverRemote() {
    setConflictBanner(null);
    const stamped = tasks.map(t => ({ ...t, lastModified: Date.now() }));
    persist(stamped);
  }

  const thisWeekTasks = useMemo(() => tasks.filter(isDueThisWeek), [tasks]);
  const completedCount = thisWeekTasks.filter(t => {
    const { start, end } = getWeekRange();
    return (t.completionHistory || []).some(d => { const dd = new Date(d); return dd >= start && dd <= end; });
  }).length;
  const filteredAllTasks = useMemo(() => tasks.filter(t => {
    if (filterCategory !== "all" && t.category !== filterCategory) return false;
    if (filterAssignee !== "all" && t.assignedTo !== filterAssignee) return false;
    return true;
  }), [tasks, filterCategory, filterAssignee]);
  const assigneeOptions = useMemo(() => [
    ...settings.parentNames, "Both Parents", ...(settings.kidNames || []), "Anyone", "Family",
  ], [settings]);
  const aiCfg = {
    backendUrl: effectiveBackendUrl,
    sharedSecret: effectiveSharedSecret,
    enabled: settings.aiEnabled && !!effectiveBackendUrl,
  };

  if (loading || !identityReady) {
    return (
      <div style={styles.loadingShell}>
        <FontStyles />
        <div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, color: "#1B2C3A" }}>Loading the ledger...</div>
      </div>
    );
  }

  if (!identity) {
    return (
      <div style={styles.shell}>
        <FontStyles />
        <div style={styles.grain} />
        <IdentityPicker
          settings={settings}
          onPick={async (data) => { const id = makeIdentity(data); await saveIdentity(id); setIdentity(id); }}
          onSkip={async () => { const id = makeIdentity({ name: "Family", role: "parent" }); await saveIdentity(id); setIdentity(id); }}
        />
      </div>
    );
  }

  return (
    <div style={styles.shell}>
      <FontStyles />
      <KeyframeStyles />
      <div style={styles.grain} />
      <div style={styles.container}>
        <Header
          view={view} setView={setView}
          weekRange={getWeekRange()}
          completedCount={completedCount} totalCount={thisWeekTasks.length}
          syncStatus={syncStatus} syncError={syncError}
          backendUrl={effectiveBackendUrl}
          backendConfigured={!!effectiveBackendUrl}
          identity={identity}
        />

        {updateReady && (
          <div style={styles.updateBanner}>
            <RefreshCw size={16} />
            New version of the ledger is ready.
            <button style={{ ...styles.linkBtn, marginLeft: "auto" }}
              onClick={() => { window.__ledgerUpdateSW && window.__ledgerUpdateSW(true); }}>
              Reload now
            </button>
          </div>
        )}

        {conflictBanner && (
          <div style={styles.conflictBanner}>
            <AlertCircle size={16} />
            A newer copy is on the Sheet ({conflictBanner.remoteCount} task{conflictBanner.remoteCount > 1 ? "s" : ""} changed).
            <button style={styles.linkBtn} onClick={adoptRemote}>Adopt remote</button>
            <button style={styles.linkBtn} onClick={keepLocalOverRemote}>Keep my version</button>
          </div>
        )}

        {storageError && (
          <div style={styles.errorBanner}><AlertCircle size={16} /> {storageError}</div>
        )}

        {syncStatus === "error" && syncError && (
          <SyncErrorBanner error={syncError} backendUrl={effectiveBackendUrl} onRetry={() => persist(tasks)} />
        )}

        {view === "dashboard" && (
          <Dashboard
            tasks={thisWeekTasks} allTasks={tasks}
            onToggle={toggleComplete}
            onEdit={(t) => { setEditingTask(t); setView("add"); }}
            onAdd={() => { setEditingTask(null); setView("add"); }}
            onQuickAdd={upsertTask}
            onSnooze={snoozeTask}
            onExportICS={() => downloadICS(thisWeekTasks)}
            groupBy={groupBy} setGroupBy={setGroupBy}
            assigneeOptions={assigneeOptions}
            events={events} identity={identity} aiCfg={aiCfg}
            categories={CATEGORIES} frequencies={FREQUENCIES}
          />
        )}
        {view === "all" && (
          <AllTasks tasks={filteredAllTasks} allTasks={tasks}
            onEdit={(t) => { setEditingTask(t); setView("add"); }}
            onDelete={deleteTask}
            onAdd={() => { setEditingTask(null); setView("add"); }}
            onUnsnooze={unsnoozeTask}
            onExportICS={() => downloadICS(tasks.filter(t => t.frequency !== "once" || t.deadline))}
            filterCategory={filterCategory} setFilterCategory={setFilterCategory}
            filterAssignee={filterAssignee} setFilterAssignee={setFilterAssignee}
            assigneeOptions={assigneeOptions} />
        )}
        {view === "add" && (
          <TaskForm task={editingTask} onSave={upsertTask}
            onCancel={() => { setEditingTask(null); setView(editingTask ? "all" : "dashboard"); }}
            assigneeOptions={assigneeOptions} aiCfg={aiCfg} />
        )}
        {view === "email" && (
          <EmailPreview tasks={thisWeekTasks} weekRange={getWeekRange()} settings={settings} />
        )}
        {view === "brainstorm" && (
          <BrainstormView
            household={{ parentNames: settings.parentNames, kidNames: settings.kidNames }}
            aiCfg={aiCfg}
            categories={CATEGORIES}
            frequencies={FREQUENCIES}
            assigneeOptions={assigneeOptions}
            onAddTask={upsertTask}
            onAddTasks={upsertTasks}
          />
        )}
        {view === "insights" && (
          <InsightsView tasks={tasks} events={events} aiCfg={aiCfg} identity={identity} settings={settings} />
        )}
        {view === "settings" && (
          <Settings settings={settings} onSave={persistSettings}
            identity={identity}
            onResetIdentity={async () => { await clearIdentity(); setIdentity(null); }}
            backendUrl={effectiveBackendUrl} sharedSecret={effectiveSharedSecret}
            envBackendUrl={ENV_BACKEND_URL} />
        )}
      </div>
      {celebration && <Celebration data={celebration} />}
    </div>
  );
}

/* IDENTITY PICKER */
function IdentityPicker({ settings, onPick, onSkip }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("parent");
  const suggested = [
    ...(settings.parentNames || []).filter(Boolean).map(n => ({ name: n, role: "parent" })),
    ...(settings.kidNames || []).filter(Boolean).map(n => ({ name: n, role: "kid" })),
  ];
  return (
    <div style={{ ...styles.container, maxWidth: 520, paddingTop: 80 }}>
      <div style={styles.formCard}>
        <div style={styles.eyebrow}>Welcome</div>
        <h1 style={{ ...styles.title, fontSize: 36, marginBottom: 16 }}>
          Who's <span style={{ fontStyle: "italic", color: "#C9603C" }}>using</span> this device?
        </h1>
        <p style={{ color: "#6B6B6B", marginTop: 0 }}>
          We'll attribute completions to you so streaks and the weekly leaderboard work.
        </p>
        {suggested.length > 0 && (
          <div style={{ marginTop: 20, marginBottom: 24 }}>
            <label style={styles.label}>Pick from your household</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {suggested.map((s, i) => (
                <button key={i} style={styles.ghostBtn} onClick={() => onPick(s)}>
                  {s.role === "kid" ? "\u{1F98A}" : "\u{1F4D2}"} {s.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div style={{ marginTop: 16 }}>
          <Field label="Or enter a new name" full>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" style={styles.input} />
          </Field>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => setRole("parent")}
              style={{ ...styles.toggleBtn, ...(role === "parent" ? styles.toggleBtnActive : {}), border: "1px solid #D9D2C4", borderRadius: 3 }}>Parent</button>
            <button onClick={() => setRole("kid")}
              style={{ ...styles.toggleBtn, ...(role === "kid" ? styles.toggleBtnActive : {}), border: "1px solid #D9D2C4", borderRadius: 3 }}>Kid</button>
          </div>
        </div>
        <div style={styles.formActions}>
          <button style={styles.ghostBtn} onClick={onSkip}>Skip for now</button>
          <button style={styles.primaryBtn} disabled={!name.trim()} onClick={() => onPick({ name: name.trim(), role })}>
            Continue <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* HEADER */
function Header({ view, setView, weekRange, completedCount, totalCount, syncStatus, syncError, backendUrl, backendConfigured, identity }) {
  const weekLabel = weekRange.start.toLocaleDateString(undefined, { month: "long", day: "numeric" }) + " - " + weekRange.end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const navItems = [
    { id: "dashboard",  label: "This Week",    icon: Home },
    { id: "all",        label: "All Tasks",    icon: List },
    { id: "brainstorm", label: "Brainstorm",   icon: MessageCircle },
    { id: "insights",   label: "Insights",     icon: Brain },
    { id: "email",      label: "Sunday Email", icon: Mail },
    { id: "settings",   label: "Settings",     icon: SettingsIcon },
  ];
  const pct = totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100);
  return (
    <header style={styles.header}>
      <div style={styles.headerTop}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.eyebrow}>
            The Family Ledger · Week of {weekLabel}
            {backendConfigured && <SyncBadge status={syncStatus} error={syncError} backendUrl={backendUrl} />}
          </div>
          <h1 style={styles.title}>
            <span style={{ fontStyle: "italic", color: "#C9603C" }}>House</span> business.
          </h1>
          {identity && (
            <div style={{ fontSize: 13, color: "#8A8579", marginTop: 4 }}>
              Hi, {identity.emoji} {identity.name}.
            </div>
          )}
        </div>
        <div style={styles.scoreCard}>
          <div style={styles.scoreLabel}>This Week</div>
          <div style={styles.scoreValue}>
            {completedCount}<span style={styles.scoreDivider}>/</span><span style={styles.scoreTotal}>{totalCount}</span>
          </div>
          <div style={styles.scoreProgressTrack}>
            <div style={{ ...styles.scoreProgressFill, width: pct + "%" }} />
          </div>
          <div style={styles.scoreSub}>{pct}% complete</div>
        </div>
      </div>
      <nav style={styles.nav}>
        {navItems.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setView(id)}
            style={{ ...styles.navBtn, ...(view === id ? styles.navBtnActive : { borderBottomColor: "transparent" }) }}>
            <Icon size={15} strokeWidth={1.75} /><span>{label}</span>
          </button>
        ))}
      </nav>
    </header>
  );
}

function SyncBadge({ status, error, backendUrl }) {
  const [open, setOpen] = useState(false);
  const map = {
    syncing: { Icon: Cloud,    color: "#8A8579", text: "syncing..." },
    ok:      { Icon: Cloud,    color: "#5C7A3F", text: "synced" },
    error:   { Icon: CloudOff, color: "#A04848", text: "sync error" },
    queued:  { Icon: Cloud,    color: "#8A8579", text: "queued (offline)" },
    idle:    { Icon: Cloud,    color: "#8A8579", text: "ready" },
  };
  const { Icon, color, text } = map[status] || map.idle;
  const errorMsg = error ? error.message + (error.hint ? " · " + error.hint : "") : "";
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <span onClick={() => error && setOpen(o => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 12, color, fontSize: 11, cursor: error ? "pointer" : "default" }}
        title={errorMsg}>
        <Icon size={12} /> {text}
        {error && <ChevronDown size={11} />}
      </span>
      {open && error && (
        <div style={styles.syncErrorPopover}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{error.message}</div>
          {error.hint && <div style={{ fontSize: 11, color: "#8A8579", marginBottom: 8 }}>{error.hint}</div>}
          <button style={{ ...styles.linkBtn, padding: 0 }}
            onClick={() => { navigator.clipboard.writeText(formatDebugInfo(error, backendUrl)).catch(() => {}); setOpen(false); }}>
            Copy debug info
          </button>
        </div>
      )}
    </span>
  );
}

function SyncErrorBanner({ error, backendUrl, onRetry }) {
  return (
    <div style={styles.errorBanner}>
      <AlertCircle size={16} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div><strong>Sync failed:</strong> {error.message}</div>
        {error.hint && <div style={{ fontSize: 12, color: "#6B5444", marginTop: 2 }}>{error.hint}</div>}
      </div>
      <button style={styles.linkBtn} onClick={onRetry}>Retry</button>
      <button style={styles.linkBtn}
        onClick={() => navigator.clipboard.writeText(formatDebugInfo(error, backendUrl)).catch(() => {})}>
        Copy debug info
      </button>
    </div>
  );
}

/* DASHBOARD */
function Dashboard({ tasks, allTasks, onToggle, onEdit, onAdd, onQuickAdd, onSnooze, onExportICS, groupBy, setGroupBy, assigneeOptions, events, identity, aiCfg, categories, frequencies }) {
  const grouped = useMemo(() => {
    const g = {};
    if (groupBy === "category") tasks.forEach(t => { (g[t.category] ||= []).push(t); });
    else tasks.forEach(t => { (g[t.priority] ||= []).push(t); });
    return g;
  }, [tasks, groupBy]);
  const groupOrder = groupBy === "category" ? CATEGORIES.map(c => c.id) : PRIORITIES.map(p => p.id);
  const getMeta = (key) => groupBy === "category" ? CATEGORIES.find(c => c.id === key) : PRIORITIES.find(p => p.id === key);

  if (tasks.length === 0) {
    return (
      <>
        <QuickAdd onAdd={onQuickAdd} assigneeOptions={assigneeOptions} events={events} aiCfg={aiCfg} categories={categories} frequencies={frequencies} />
        <div style={styles.emptyState}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, margin: "0 0 8px" }}>A clean slate this week.</h2>
          <p style={{ color: "#6B6B6B", margin: "0 0 24px" }}>Nothing due. Quick-add a task above, or open the full form.</p>
          <button style={styles.primaryBtn} onClick={onAdd}><Plus size={16} /> Add a task</button>
        </div>
      </>
    );
  }

  return (
    <div>
      <QuickAdd onAdd={onQuickAdd} assigneeOptions={assigneeOptions} events={events} aiCfg={aiCfg} categories={categories} frequencies={frequencies} />
      <LeaderboardStrip allTasks={allTasks} identity={identity} />
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>This week's plays</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={styles.toggleGroup}>
            <button onClick={() => setGroupBy("category")}
              style={{ ...styles.toggleBtn, ...(groupBy === "category" ? styles.toggleBtnActive : {}) }}>By category</button>
            <button onClick={() => setGroupBy("priority")}
              style={{ ...styles.toggleBtn, ...(groupBy === "priority" ? styles.toggleBtnActive : {}) }}>By priority</button>
          </div>
          <button style={styles.ghostBtn} onClick={onExportICS}><CalendarDays size={14} /> Export</button>
          <button style={styles.primaryBtn} onClick={onAdd}><Plus size={16} /> Add</button>
        </div>
      </div>
      {groupOrder.map(key => {
        const items = grouped[key];
        if (!items || items.length === 0) return null;
        const meta = getMeta(key);
        const doneCount = items.filter(t => {
          const { start, end } = getWeekRange();
          return (t.completionHistory || []).some(d => new Date(d) >= start && new Date(d) <= end);
        }).length;
        return (
          <section key={key} style={styles.categorySection}>
            <div style={styles.categoryHeader}>
              <div style={{ ...styles.categoryDot, backgroundColor: meta.color }} />
              <h3 style={styles.categoryTitle}>{meta.label}{groupBy === "priority" ? " priority" : ""}</h3>
              <div style={styles.categoryCount}>{doneCount} / {items.length}</div>
            </div>
            <div style={styles.taskGrid}>
              {items.map(t => (
                <TaskCard key={t.id} task={t}
                  onToggle={() => onToggle(t.id)}
                  onEdit={() => onEdit(t)}
                  onSnooze={(d) => onSnooze(t.id, d)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function LeaderboardStrip({ allTasks, identity }) {
  const { start, end } = getWeekRange();
  const board = useMemo(() => weeklyLeaderboard(allTasks, start, end), [allTasks, start, end]);
  if (board.length === 0) return null;
  const max = Math.max(1, ...board.map(b => b.count));
  return (
    <div style={styles.leaderboardCard}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Trophy size={16} color="#C9603C" />
        <h3 style={{ ...styles.categoryTitle, fontSize: 14, margin: 0 }}>This week's leaderboard</h3>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {board.map(({ name, count }) => {
          const me = identity && identity.name === name;
          return (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 110, fontSize: 13, fontWeight: me ? 600 : 400, color: me ? "#1B2C3A" : "#6B6B6B" }}>
                {name}{me ? " (you)" : ""}
              </div>
              <div style={{ flex: 1, height: 6, background: "#F2EDE4", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: (count / max * 100) + "%", background: me ? "#C9603C" : "#1B2C3A" }} />
              </div>
              <div style={{ width: 32, fontSize: 12, fontVariantNumeric: "tabular-nums", textAlign: "right", color: "#8A8579" }}>{count}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* TASK CARD */
function TaskCard({ task, onToggle, onEdit, onSnooze }) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const cat = CATEGORIES.find(c => c.id === task.category) || CATEGORIES[CATEGORIES.length - 1];
  const freq = FREQUENCIES.find(f => f.id === task.frequency);
  const dDays = daysUntil(task.deadline);
  const streak = calcStreak(task);
  const priorityMeta = PRIORITIES.find(p => p.id === task.priority);
  const { start, end } = getWeekRange();
  const isDone = (task.completionHistory || []).some(d => { const dd = new Date(d); return dd >= start && dd <= end; });
  const snoozeFor = (offset) => {
    const d = new Date(); d.setDate(d.getDate() + offset);
    onSnooze(toISO(d));
    setSnoozeOpen(false);
  };
  return (
    <div style={{
      ...styles.taskCard,
      ...(isDone ? styles.taskCardDone : {}),
      borderLeftColor: cat.color,
      borderLeftWidth: task.priority === "high" ? 4 : 3,
    }}>
      <button onClick={onToggle} className="ledger-checkbox" style={{
        ...styles.checkbox,
        backgroundColor: isDone ? "#1B2C3A" : "transparent",
        borderColor: isDone ? "#1B2C3A" : "#C9C2B5",
      }} aria-label={isDone ? "Mark incomplete" : "Mark complete"}>
        {isDone && <Check size={14} color="#FAF7F2" strokeWidth={3} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={styles.taskTitleRow}>
          <h4 style={{ ...styles.taskTitle,
            textDecoration: isDone ? "line-through" : "none",
            color: isDone ? "#9A9489" : "#1B2C3A",
          }}>{task.title}</h4>
          {streak >= 2 && <StreakBadge streak={streak} muted={isDone} />}
          {task.priority === "high" && !isDone && (<span style={styles.priorityHigh}>Priority</span>)}
        </div>
        {task.details && <p style={styles.taskDetails}>{task.details}</p>}
        <div style={styles.taskMeta}>
          <span style={styles.metaChip}><Users size={11} /> {task.assignedTo}</span>
          <span style={styles.metaChip}>{freq && freq.label}</span>
          {task.deadline && (
            <span style={{ ...styles.metaChip,
              color: dDays !== null && dDays < 0 ? "#A04848" : (dDays !== null && dDays <= 2 ? "#C9603C" : "#8A8579"),
              fontWeight: dDays !== null && dDays <= 2 ? 600 : 400,
            }}>
              <Calendar size={11} /> {formatDate(task.deadline)}
              {dDays !== null && dDays <= 7 && dDays >= 0 && " · " + dDays + "d"}
              {dDays !== null && dDays < 0 && " · overdue"}
            </span>
          )}
          <span style={{ ...styles.metaChip, color: priorityMeta && priorityMeta.color }}>
            • {priorityMeta && priorityMeta.label.toLowerCase()}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 2, position: "relative" }}>
        <button onClick={() => setSnoozeOpen(s => !s)} style={styles.iconBtn} title="Snooze"><Clock size={14} /></button>
        <button onClick={onEdit} style={styles.iconBtn} aria-label="Edit"><Edit2 size={14} /></button>
        {snoozeOpen && (
          <SnoozeMenu onPick={snoozeFor}
            onCustom={(d) => { onSnooze(d); setSnoozeOpen(false); }}
            onClose={() => setSnoozeOpen(false)} />
        )}
      </div>
    </div>
  );
}

function StreakBadge({ streak, muted }) {
  return (
    <span className={muted ? "" : "ledger-streak-pulse"} style={{ ...styles.streakBadge, opacity: muted ? 0.5 : 1 }}>
      <Flame size={11} strokeWidth={2.25} />{streak}
    </span>
  );
}

function SnoozeMenu({ onPick, onCustom, onClose }) {
  const [customDate, setCustomDate] = useState("");
  useEffect(() => {
    const handler = (e) => { if (!e.target.closest(".snooze-menu")) onClose(); };
    setTimeout(() => document.addEventListener("click", handler), 0);
    return () => document.removeEventListener("click", handler);
  }, [onClose]);
  return (
    <div className="snooze-menu" style={styles.snoozeMenu}>
      <div style={styles.snoozeTitle}>Snooze until...</div>
      <button style={styles.snoozeItem} onClick={() => onPick(1)}>Tomorrow</button>
      <button style={styles.snoozeItem} onClick={() => onPick(7)}>Next week</button>
      <button style={styles.snoozeItem} onClick={() => onPick(14)}>In 2 weeks</button>
      <button style={styles.snoozeItem} onClick={() => onPick(30)}>Next month</button>
      <div style={styles.snoozeCustom}>
        <input type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)}
          style={{ ...styles.input, padding: "6px 8px", fontSize: 12 }} />
        <button style={{ ...styles.primaryBtn, padding: "6px 10px", fontSize: 12 }}
          onClick={() => customDate && onCustom(customDate)}>Set</button>
      </div>
    </div>
  );
}

/* QUICK ADD */
function QuickAdd({ onAdd, assigneeOptions, events, aiCfg, categories, frequencies }) {
  const [title, setTitle] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [category, setCategory] = useState("life-admin");
  const [frequency, setFrequency] = useState("weekly");
  const [assignedTo, setAssignedTo] = useState("Anyone");
  const [priority, setPriority] = useState("medium");
  const [deadline, setDeadline] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiHint, setAiHint] = useState(null);

  const sortedCategories = useMemo(() => rerankByUsage(categories, events, (m) => m.category), [events, categories]);
  const sortedFrequencies = useMemo(() => rerankByUsage(frequencies, events, (m) => m.frequency), [events, frequencies]);

  const submit = () => {
    if (!title.trim()) return;
    onAdd({ title: title.trim(), details: "", category, frequency, assignedTo, priority, deadline: deadline || null });
    setTitle(""); setDeadline(""); setAiHint(null); setExpanded(false);
  };

  const autoFill = async () => {
    if (!aiCfg.enabled) { setAiHint({ error: "Enable the AI agent (Settings > AI agent)." }); return; }
    if (!title.trim()) return;
    setAiBusy(true); setAiHint(null);
    const r = await suggestTaskMetadata({
      backendUrl: aiCfg.backendUrl, sharedSecret: aiCfg.sharedSecret,
      title: title.trim(), knownAssignees: assigneeOptions, categories, frequencies,
    });
    setAiBusy(false);
    if (!r || r.error) { setAiHint({ error: (r && r.error && r.error.message) || "AI couldn't help." }); return; }
    if (r.category)   setCategory(r.category);
    if (r.frequency)  setFrequency(r.frequency);
    if (r.priority)   setPriority(r.priority);
    if (r.assignedTo && assigneeOptions.includes(r.assignedTo)) setAssignedTo(r.assignedTo);
    if (r.deadline)   setDeadline(r.deadline);
    setAiHint({ ok: "Filled from title - review below." });
  };

  return (
    <div style={{ ...styles.quickAdd, ...(expanded ? styles.quickAddExpanded : {}) }}>
      <div style={styles.quickAddRow}>
        <Zap size={16} color="#C9603C" strokeWidth={2.25} />
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          onFocus={() => setExpanded(true)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setExpanded(false); }}
          placeholder="Quick add a task and hit Enter..."
          style={styles.quickAddInput} />
        {expanded && (
          <>
            <button style={styles.ghostBtn} onClick={autoFill} disabled={aiBusy || !title.trim()}
              title="Ask the AI to fill category/frequency/priority">
              <Wand2 size={14} /> {aiBusy ? "Thinking..." : "AI fill"}
            </button>
            <button style={styles.primaryBtn} onClick={submit}>Add</button>
          </>
        )}
      </div>
      {expanded && (
        <>
          <div style={styles.quickAddOptions}>
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={styles.select}>
              {sortedCategories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)} style={styles.select}>
              {sortedFrequencies.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} style={styles.select}>
              {assigneeOptions.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} style={styles.select}>
              {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)}
              style={{ ...styles.select, padding: "6px 10px" }} />
            <button style={styles.ghostBtn} onClick={() => setExpanded(false)}><X size={14} /></button>
          </div>
          {aiHint && (
            <div style={{ fontSize: 12, marginTop: 8, color: aiHint.error ? "#A04848" : "#5C7A3F" }}>
              {aiHint.error || aiHint.ok}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ALL TASKS */
function AllTasks({ tasks, allTasks, onEdit, onDelete, onAdd, onUnsnooze, onExportICS, filterCategory, setFilterCategory, filterAssignee, setFilterAssignee, assigneeOptions }) {
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  return (
    <div>
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>Every task ({tasks.length}{tasks.length !== allTasks.length ? ` of ${allTasks.length}` : ""})</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={styles.ghostBtn} onClick={onExportICS}><Download size={14} /> Export all (.ics)</button>
          <button style={styles.primaryBtn} onClick={onAdd}><Plus size={16} /> Add task</button>
        </div>
      </div>
      <div style={styles.filterBar}>
        <div style={styles.filterGroup}>
          <Filter size={13} color="#6B6B6B" />
          <span style={styles.filterLabel}>Category</span>
          <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} style={styles.select}>
            <option value="all">All</option>
            {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div style={styles.filterGroup}>
          <span style={styles.filterLabel}>Assigned to</span>
          <select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)} style={styles.select}>
            <option value="all">All</option>
            {assigneeOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={styles.table}>
          <thead>
            <tr style={styles.tableHeadRow}>
              <th style={styles.th}>Task</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Assigned</th>
              <th style={styles.th}>Frequency</th>
              <th style={styles.th}>Deadline</th>
              <th style={styles.th}>Priority</th>
              <th style={styles.th}>Streak</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {tasks.map(t => {
              const cat = CATEGORIES.find(c => c.id === t.category);
              const freq = FREQUENCIES.find(f => f.id === t.frequency);
              const streak = calcStreak(t);
              const snoozed = isSnoozed(t);
              return (
                <tr key={t.id} style={styles.tableRow}>
                  <td style={styles.td}>
                    <div style={{ fontWeight: 500, color: "#1B2C3A" }}>{t.title}</div>
                    {t.details && (
                      <div style={{ fontSize: 12, color: "#8A8579", marginTop: 2 }}>
                        {t.details.length > 80 ? t.details.slice(0, 80) + "..." : t.details}
                      </div>
                    )}
                  </td>
                  <td style={styles.td}>
                    <span style={{ ...styles.categoryPill, borderColor: cat && cat.color, color: cat && cat.color }}>{cat && cat.label}</span>
                  </td>
                  <td style={styles.td}>{t.assignedTo}</td>
                  <td style={styles.td}>{freq && freq.label}</td>
                  <td style={styles.td}>{formatDate(t.deadline) || "--"}</td>
                  <td style={styles.td}>
                    <span style={{ ...styles.priorityPill,
                      ...(t.priority === "high" ? styles.priorityPillHigh : {}),
                      ...(t.priority === "low" ? styles.priorityPillLow : {}),
                    }}>{t.priority}</span>
                  </td>
                  <td style={styles.td}>
                    {streak >= 2 ? <StreakBadge streak={streak} muted /> : <span style={{ color: "#C9C2B5" }}>--</span>}
                  </td>
                  <td style={styles.td}>
                    {snoozed ? (
                      <button style={styles.snoozedPill} onClick={() => onUnsnooze(t.id)} title="Unsnooze">
                        <Clock size={11} /> snoozed · {formatDate(t.snoozedUntil)}
                      </button>
                    ) : (<span style={{ color: "#C9C2B5" }}>active</span>)}
                  </td>
                  <td style={styles.td}>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button style={styles.iconBtn} onClick={() => onEdit(t)}><Edit2 size={13} /></button>
                      <button style={{ ...styles.iconBtn, color: "#A04848" }}
                        onClick={() => setConfirmDeleteId(t.id)} style={{ ...(confirmDeleteId === t.id ? { color: "#A04848", fontWeight: 700 } : {}) }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {confirmDeleteId === t.id && (
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                        <span style={{ fontSize: 12, color: "#A04848" }}>Delete this task?</span>
                        <button style={{ fontSize: 11, padding: "2px 8px", background: "#A04848", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer" }} onClick={() => { onDelete(t.id); setConfirmDeleteId(null); }}>Yes, delete</button>
                        <button style={{ fontSize: 11, padding: "2px 8px", background: "transparent", border: "1px solid #D9D2C4", borderRadius: 3, cursor: "pointer" }} onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* TASK FORM */
function TaskForm({ task, onSave, onCancel, assigneeOptions, aiCfg }) {
  const [form, setForm] = useState(task ? { ...task, deadline: task.deadline ? task.deadline.slice(0, 10) : "" } : {
    title: "", details: "", category: "life-admin", assignedTo: "Anyone",
    frequency: "weekly", deadline: "", priority: "medium",
  });
  const [parseBusy, setParseBusy] = useState(false);
  const [parseHint, setParseHint] = useState(null);
  const [phrase, setPhrase] = useState("");
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [titleError, setTitleError] = useState(false);
  const submit = () => {
    if (!form.title.trim()) { setTitleError(true); return; }
    setTitleError(false);
    onSave({ ...form, deadline: form.deadline || null });
  };

  const parseAndApply = async () => {
    if (!aiCfg || !aiCfg.enabled || !phrase.trim()) return;
    setParseBusy(true); setParseHint(null);
    const r = await parseDeadline({
      backendUrl: aiCfg.backendUrl, sharedSecret: aiCfg.sharedSecret,
      phrase: phrase.trim(), today: toISO(new Date()),
    });
    setParseBusy(false);
    if (!r || r.error || !r.iso) { setParseHint({ error: (r && r.error && r.error.message) || "Couldn't parse that." }); return; }
    update("deadline", r.iso);
    setParseHint({ ok: "Set to " + (r.label || r.iso) });
  };

  return (
    <div style={styles.formCard}>
      <div style={styles.formHeader}>
        <h2 style={styles.sectionTitle}>{task ? "Edit task" : "New task"}</h2>
        <button onClick={onCancel} style={styles.iconBtn}><X size={18} /></button>
      </div>
      <div style={styles.formGrid}>
        <Field label="Title" full>
          <input value={form.title} onChange={(e) => { update("title", e.target.value); if (e.target.value.trim()) setTitleError(false); }}
            placeholder="e.g. File Q1 sales tax" style={{ ...styles.input, ...(titleError ? { borderColor: "#A04848", boxShadow: "0 0 0 2px rgba(160,72,72,0.2)" } : {}) }} />
          {titleError && <div style={{ color: "#A04848", fontSize: 12, marginTop: 4 }}>Title is required</div>}
        </Field>
        <Field label="Details" full>
          <textarea value={form.details} onChange={(e) => update("details", e.target.value)}
            placeholder="Account numbers, links, instructions, anything the other parent needs."
            rows={3} style={{ ...styles.input, fontFamily: "inherit", resize: "vertical" }} />
        </Field>
        <Field label="Category">
          <select value={form.category} onChange={(e) => update("category", e.target.value)} style={styles.input}>
            {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Assigned to">
          <select value={form.assignedTo} onChange={(e) => update("assignedTo", e.target.value)} style={styles.input}>
            {assigneeOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Frequency">
          <select value={form.frequency} onChange={(e) => update("frequency", e.target.value)} style={styles.input}>
            {FREQUENCIES.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select value={form.priority} onChange={(e) => update("priority", e.target.value)} style={styles.input}>
            {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Field>
        <Field label="Deadline (optional)" full>
          <input type="date" value={form.deadline || ""} onChange={(e) => update("deadline", e.target.value)} style={styles.input} />
          {aiCfg && aiCfg.enabled && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input value={phrase} onChange={(e) => setPhrase(e.target.value)}
                placeholder='or type "next Friday", "end of month"'
                style={{ ...styles.input, flex: 1 }} />
              <button onClick={parseAndApply} style={styles.ghostBtn} disabled={parseBusy || !phrase.trim()}>
                <Wand2 size={14} /> {parseBusy ? "Parsing..." : "Set"}
              </button>
            </div>
          )}
          {parseHint && (
            <div style={{ fontSize: 12, marginTop: 6, color: parseHint.error ? "#A04848" : "#5C7A3F" }}>
              {parseHint.error || parseHint.ok}
            </div>
          )}
        </Field>
      </div>
      <div style={styles.formActions}>
        <button onClick={onCancel} style={styles.ghostBtn}>Cancel</button>
        <button onClick={submit} style={styles.primaryBtn}>{task ? "Save changes" : "Add task"}</button>
      </div>
    </div>
  );
}

function Field({ label, full, children }) {
  return (
    <div style={{ gridColumn: full ? "1 / -1" : "auto" }}>
      <label style={styles.label}>{label}</label>
      {children}
    </div>
  );
}

/* EMAIL PREVIEW */
function EmailPreview({ tasks, weekRange, settings }) {
  const [copied, setCopied] = useState(false);
  const grouped = useMemo(() => { const g = {}; tasks.forEach(t => { (g[t.category] ||= []).push(t); }); return g; }, [tasks]);
  const subject = "The Week of " + weekRange.start.toLocaleDateString(undefined, { month: "long", day: "numeric" }) + " - " + tasks.length + " items on the ledger";
  const emailText = useMemo(() => {
    const lines = [];
    lines.push("Good Sunday morning, " + settings.parentNames.join(" & ") + ".");
    lines.push("");
    lines.push("Here's what's on the ledger this week (" + tasks.length + " items):");
    lines.push("");
    CATEGORIES.forEach(cat => {
      const items = grouped[cat.id];
      if (!items || items.length === 0) return;
      lines.push("## " + cat.label.toUpperCase());
      items.forEach(t => {
        const freq = FREQUENCIES.find(f => f.id === t.frequency);
        const deadline = t.deadline ? " · due " + formatDate(t.deadline) : "";
        const prio = t.priority === "high" ? " · PRIORITY" : "";
        const streak = calcStreak(t);
        const streakStr = streak >= 2 ? " · \u{1F525}" + streak : "";
        lines.push("• " + t.title + " (" + t.assignedTo + " · " + freq.label + deadline + streakStr + ")" + prio);
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
  }, [tasks, grouped, settings]);
  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText("Subject: " + subject + "\n\n" + emailText);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch (e) { alert("Copy failed: " + e.message); }
  };
  return (
    <div>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.sectionTitle}>Sunday morning email</h2>
          <p style={{ color: "#6B6B6B", fontSize: 14, margin: "4px 0 0" }}>
            This is what Apps Script sends every Sunday at 7am from your configured backend.
          </p>
        </div>
        <button style={styles.primaryBtn} onClick={copyEmail}>
          <Copy size={16} /> {copied ? "Copied!" : "Copy email"}
        </button>
      </div>
      <div style={styles.emailCard}>
        <div style={styles.emailMeta}>
          <div><span style={styles.emailMetaLabel}>From</span><span>The Family Ledger</span></div>
          <div><span style={styles.emailMetaLabel}>To</span><span>{settings.parentEmails.filter(Boolean).join(", ") || settings.parentNames.join(", ")}</span></div>
          <div><span style={styles.emailMetaLabel}>Subject</span><span style={{ fontWeight: 500 }}>{subject}</span></div>
        </div>
        <pre style={styles.emailBody}>{emailText}</pre>
      </div>
    </div>
  );
}

/* INSIGHTS */
function InsightsView({ tasks, events, aiCfg, identity, settings }) {
  const trend = useMemo(() => throughputTrend(tasks), [tasks]);
  const stale = useMemo(() => findStaleTasks(tasks, 30), [tasks]);
  const snoozePatterns = useMemo(() => detectSnoozePatterns(events), [events]);
  const repeats = useMemo(() => detectRepeatQuickAdds(events), [events]);
  const myStreak = useMemo(() => personalDailyStreak(tasks, identity && identity.name), [tasks, identity]);
  const [retro, setRetro] = useState(null);
  const [retroBusy, setRetroBusy] = useState(false);

  const runRetro = async () => {
    if (!aiCfg.enabled) return;
    setRetroBusy(true);
    const snapshot = {
      throughput: trend,
      leaderboard: weeklyLeaderboard(tasks, getWeekRange().start, getWeekRange().end),
      staleCount: stale.length,
      snoozePatternCount: snoozePatterns.length,
      tasks: tasks.slice(0, 40).map(t => ({
        title: t.title, category: t.category, frequency: t.frequency, priority: t.priority,
        lastCompleted: t.lastCompleted,
        completionsThisWeek: (t.completionHistory || []).filter(d => new Date(d) >= getWeekRange().start).length,
        snoozed: !!t.snoozedUntil,
      })),
    };
    const r = await weeklyRetrospective({ backendUrl: aiCfg.backendUrl, sharedSecret: aiCfg.sharedSecret, snapshot });
    setRetroBusy(false);
    if (r && !r.error) setRetro(r);
    else setRetro({ error: (r && r.error && r.error.message) || "AI unavailable." });
  };

  const trendDelta = trend.thisWeek - trend.lastWeek;
  const TrendIcon = trendDelta >= 0 ? TrendingUp : TrendingDown;
  const trendColor = trendDelta >= 0 ? "#5C7A3F" : "#A04848";

  return (
    <div>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.sectionTitle}>Insights</h2>
          <p style={{ color: "#6B6B6B", fontSize: 14, margin: "4px 0 0" }}>
            How the household is trending. The ledger watches itself and surfaces patterns.
          </p>
        </div>
        {aiCfg.enabled && (
          <button style={styles.primaryBtn} onClick={runRetro} disabled={retroBusy}>
            <Brain size={16} /> {retroBusy ? "Reflecting..." : "Run weekly retrospective"}
          </button>
        )}
      </div>
      <div style={styles.insightGrid}>
        <div style={styles.insightCard}>
          <div style={styles.insightLabel}>Throughput</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <div style={styles.insightValue}>{trend.thisWeek}</div>
            <TrendIcon size={18} color={trendColor} />
            <div style={{ fontSize: 13, color: trendColor, fontWeight: 500 }}>
              {trendDelta >= 0 ? "+" : ""}{trendDelta}
            </div>
          </div>
          <div style={styles.insightSub}>vs {trend.lastWeek} last week, {trend.priorWeek} prior</div>
        </div>
        <div style={styles.insightCard}>
          <div style={styles.insightLabel}>Your daily streak</div>
          <div style={styles.insightValue}>{myStreak}</div>
          <div style={styles.insightSub}>{identity && identity.emoji} {identity && identity.name}</div>
        </div>
        <div style={styles.insightCard}>
          <div style={styles.insightLabel}>Stale tasks (30+ days)</div>
          <div style={{ ...styles.insightValue, color: stale.length > 5 ? "#A04848" : "#1B2C3A" }}>{stale.length}</div>
          <div style={styles.insightSub}>candidates for review or delete</div>
        </div>
        <div style={styles.insightCard}>
          <div style={styles.insightLabel}>Detected snooze patterns</div>
          <div style={styles.insightValue}>{snoozePatterns.length}</div>
          <div style={styles.insightSub}>tasks you keep pushing the same number of days</div>
        </div>
      </div>
      {retro && !retro.error && (
        <div style={styles.retroCard}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <Lightbulb size={16} color="#C9603C" />
            <h3 style={{ ...styles.categoryTitle, margin: 0 }}>This week's retrospective</h3>
          </div>
          {retro.wins && retro.wins.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={styles.retroSection}>Wins</div>
              {retro.wins.map((w, i) => <div key={i} style={styles.retroBullet}>• {w}</div>)}
            </div>
          )}
          {retro.drift && retro.drift.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={styles.retroSection}>Drift</div>
              {retro.drift.map((w, i) => <div key={i} style={styles.retroBullet}>• {w}</div>)}
            </div>
          )}
          {retro.suggestion && (
            <div style={styles.retroSuggestion}>
              <ArrowRight size={14} color="#C9603C" /> {retro.suggestion}
            </div>
          )}
        </div>
      )}
      {retro && retro.error && (
        <div style={styles.errorBanner}><AlertCircle size={16} /> {retro.error}</div>
      )}
      {snoozePatterns.length > 0 && (
        <div style={styles.formCard}>
          <h3 style={{ ...styles.categoryTitle, marginBottom: 12 }}>Patterns to consider</h3>
          {snoozePatterns.map(p => {
            const t = tasks.find(x => x.id === p.taskId);
            if (!t) return null;
            return (
              <div key={p.taskId} style={{ padding: "10px 0", borderTop: "1px solid #F0EAE0" }}>
                <strong>{t.title}</strong> - you snooze this by ~{p.suggestedDays} days every time ({p.confidence}x). Consider changing the frequency or deadline so it lines up.
              </div>
            );
          })}
        </div>
      )}
      {repeats.length > 0 && (
        <div style={{ ...styles.formCard, marginTop: 16 }}>
          <h3 style={{ ...styles.categoryTitle, marginBottom: 12 }}>Looks recurring</h3>
          <p style={{ fontSize: 13, color: "#8A8579", marginBottom: 8 }}>
            You've added these as one-offs multiple times. Consider making them recurring.
          </p>
          {repeats.map((r, i) => (
            <div key={i} style={{ padding: "8px 0", borderTop: "1px solid #F0EAE0" }}>
              <strong>{r.title}</strong> · added {r.count} times
            </div>
          ))}
        </div>
      )}
      {stale.length > 0 && (
        <div style={{ ...styles.formCard, marginTop: 16 }}>
          <h3 style={{ ...styles.categoryTitle, marginBottom: 12 }}>Stale ({stale.length})</h3>
          <p style={{ fontSize: 13, color: "#8A8579", marginBottom: 8 }}>
            Not completed in 30+ days. Edit, snooze, or delete from All Tasks.
          </p>
          {stale.slice(0, 10).map(t => (
            <div key={t.id} style={{ padding: "8px 0", borderTop: "1px solid #F0EAE0", fontSize: 14 }}>
              {t.title} <span style={{ color: "#8A8579", fontSize: 12 }}>
                - {t.lastCompleted ? "last done " + formatDate(t.lastCompleted) : "never completed"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* SETTINGS */
function Settings({ settings, onSave, identity, onResetIdentity, backendUrl, sharedSecret, envBackendUrl }) {
  const [draft, setDraft] = useState({ ...settings, backendUrl: settings.backendUrl || envBackendUrl });
  const [saved, setSaved] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [testError, setTestError] = useState(null);
  const [pushStatus, setPushStatus] = useState({ supported: false });

  useEffect(() => { getPushStatus().then(setPushStatus); }, []);
  const update = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const save = async () => { await onSave(draft); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  const updateKid = (i, v) => { const next = [...draft.kidNames]; next[i] = v; update("kidNames", next); };
  const addKid = () => update("kidNames", [...draft.kidNames, "Kid " + (draft.kidNames.length + 1)]);
  const removeKid = (i) => update("kidNames", draft.kidNames.filter((_, idx) => idx !== i));

  const effectiveUrl = draft.backendUrl || envBackendUrl;
  const effectiveSecret = draft.sharedSecret || (typeof window !== "undefined" && import.meta.env.VITE_SHARED_SECRET) || "";

  const testBackend = async () => {
    if (!effectiveUrl) return;
    setTestStatus("testing"); setTestError(null);
    const r = await pingBackend(effectiveUrl, effectiveSecret);
    if (r.ok) setTestStatus("ok");
    else { setTestStatus("fail"); setTestError(r.error); }
    setTimeout(() => { setTestStatus(null); setTestError(null); }, 6000);
  };

  const enablePush = async () => {
    const perm = await requestPushPermission();
    if (!perm.granted) { alert(perm.reason || "Permission denied"); return; }
    if (!draft.vapidPublicKey) { alert("Paste your VAPID public key first."); return; }
    const sub = await subscribeToPush(draft.vapidPublicKey);
    if (!sub.ok) { alert("Subscribe failed: " + sub.error); return; }
    const { registerPushSubscription } = await import("./sync.js");
    const r = await registerPushSubscription(effectiveUrl, sub.subscription, identity, effectiveSecret);
    if (!r.ok) { alert("Backend registration failed: " + r.error.message); return; }
    update("pushEnabled", true);
    setPushStatus(await getPushStatus());
    alert("Push notifications enabled.");
  };
  const disablePush = async () => {
    await unsubscribeFromPush();
    update("pushEnabled", false);
    setPushStatus(await getPushStatus());
  };
  const webcal = webcalUrl(effectiveUrl, effectiveSecret);

  return (
    <div>
      <div style={styles.formCard}>
        <h2 style={styles.sectionTitle}>People</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 24px" }}>Names show up in the assignee dropdown everywhere.</p>
        <div style={styles.formGrid}>
          <Field label="Parent 1 name"><input value={draft.parentNames[0]} onChange={(e) => update("parentNames", [e.target.value, draft.parentNames[1]])} style={styles.input} /></Field>
          <Field label="Parent 2 name"><input value={draft.parentNames[1]} onChange={(e) => update("parentNames", [draft.parentNames[0], e.target.value])} style={styles.input} /></Field>
          <Field label="Parent 1 email"><input type="email" value={draft.parentEmails[0]} onChange={(e) => update("parentEmails", [e.target.value, draft.parentEmails[1]])} placeholder="parent1@email.com" style={styles.input} /></Field>
          <Field label="Parent 2 email"><input type="email" value={draft.parentEmails[1]} onChange={(e) => update("parentEmails", [draft.parentEmails[0], e.target.value])} placeholder="parent2@email.com" style={styles.input} /></Field>
        </div>
        <div style={{ marginTop: 24 }}>
          <label style={styles.label}>Kids</label>
          {draft.kidNames.map((name, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input value={name} onChange={(e) => updateKid(i, e.target.value)} style={{ ...styles.input, flex: 1 }} />
              <button onClick={() => removeKid(i)} style={{ ...styles.iconBtn, color: "#A04848" }}><Trash2 size={14} /></button>
            </div>
          ))}
          <button onClick={addKid} style={styles.ghostBtn}><Plus size={14} /> Add kid</button>
        </div>
      </div>
      <div style={{ ...styles.formCard, marginTop: 24 }}>
        <h2 style={styles.sectionTitle}>This device</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 16px" }}>Used to attribute completions, streaks, and the leaderboard.</p>
        {identity ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 28 }}>{identity.emoji}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{identity.name}</div>
              <div style={{ fontSize: 12, color: "#8A8579", textTransform: "capitalize" }}>{identity.role}</div>
            </div>
            <button style={styles.ghostBtn} onClick={onResetIdentity}>Change</button>
          </div>
        ) : (<div style={{ color: "#8A8579" }}>No identity set - refresh to pick one.</div>)}
      </div>
      <div style={{ ...styles.formCard, marginTop: 24 }}>
        <h2 style={styles.sectionTitle}>Google Sheets backend</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 24px" }}>
          Paste your Apps Script Web App URL to enable Sunday emails, email-reply commands, AI features, and cross-device sync.
        </p>
        <Field label="Apps Script Web App URL" full>
          <input value={draft.backendUrl} onChange={(e) => update("backendUrl", e.target.value)}
            placeholder={envBackendUrl || "https://script.google.com/macros/s/AKfycb.../exec"} style={styles.input} />
          {envBackendUrl && !draft.backendUrl && (
            <div style={{ fontSize: 12, color: "#8A8579", marginTop: 4 }}>
              Using VITE_BACKEND_URL from build: {envBackendUrl}
            </div>
          )}
        </Field>
        <Field label="Shared secret (optional)" full>
          <input type="password" value={draft.sharedSecret} onChange={(e) => update("sharedSecret", e.target.value)}
            placeholder="Matches SHARED_SECRET in Apps Script properties" style={styles.input} />
        </Field>
        <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={testBackend} style={styles.ghostBtn} disabled={!effectiveUrl}>
            {testStatus === "testing" ? "Testing..." :
             testStatus === "ok"      ? "Connected" :
             testStatus === "fail"    ? "Failed" : "Test connection"}
          </button>
          {effectiveUrl && (<a href={effectiveUrl} target="_blank" rel="noreferrer" style={styles.linkBtn}>Open URL in new tab</a>)}
        </div>
        {testError && (
          <div style={{ ...styles.errorBanner, marginTop: 12 }}>
            <AlertCircle size={16} />
            <div>
              <strong>{testError.message}</strong>
              {testError.hint && <div style={{ fontSize: 12, color: "#6B5444", marginTop: 4 }}>{testError.hint}</div>}
            </div>
          </div>
        )}
      </div>
      <div style={{ ...styles.formCard, marginTop: 24 }}>
        <h2 style={styles.sectionTitle}>AI agent</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 16px" }}>
          Auto-categorises new tasks, parses "next Friday" into dates, and writes a weekly retrospective.
          The Anthropic API key lives in your Apps Script Script Properties - never in this browser.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <input type="checkbox" id="ai-toggle" checked={!!draft.aiEnabled}
            onChange={(e) => update("aiEnabled", e.target.checked)} />
          <label htmlFor="ai-toggle" style={{ fontSize: 14 }}>
            Enable AI features ({effectiveUrl ? "uses Apps Script proxy" : "requires backend URL above"})
          </label>
        </div>
        <div style={styles.infoBox}>
          <strong style={{ color: "#1B2C3A" }}>Setup steps</strong>
          <ol style={{ margin: "8px 0 0", paddingLeft: 20, lineHeight: 1.6 }}>
            <li>In your Apps Script project, open Project Settings &gt; Script Properties</li>
            <li>Add property <code>ANTHROPIC_API_KEY</code> with your key from console.anthropic.com</li>
            <li>Redeploy (Manage Deployments &gt; Edit &gt; Save)</li>
          </ol>
        </div>
      </div>
      <div style={{ ...styles.formCard, marginTop: 24 }}>
        <h2 style={styles.sectionTitle}>Push notifications</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 16px" }}>
          Sunday 7am summary + optional daily digest as a real push notification.
          Requires iOS 16.4+ (and the PWA must be installed) on iPhone.
        </p>
        {!pushStatus.supported && (
          <div style={{ color: "#8A8579", fontSize: 13 }}>This browser doesn't support push notifications.</div>
        )}
        {pushStatus.supported && (
          <>
            <Field label="VAPID public key" full>
              <input value={draft.vapidPublicKey} onChange={(e) => update("vapidPublicKey", e.target.value)}
                placeholder="Generated once, paste here (see DEPLOYMENT.md)" style={styles.input} />
            </Field>
            <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
              {pushStatus.subscribed
                ? <button onClick={disablePush} style={styles.ghostBtn}><BellOff size={14} /> Disable</button>
                : <button onClick={enablePush} style={styles.primaryBtn} disabled={!draft.vapidPublicKey || !effectiveUrl}>
                    <Bell size={14} /> Enable push
                  </button>}
              <div style={{ fontSize: 12, color: "#8A8579" }}>
                {pushStatus.subscribed ? "Subscribed on this device" :
                 pushStatus.permission === "denied" ? "Blocked - reset in browser settings" :
                 "Not subscribed"}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
              <input type="checkbox" id="digest-toggle" checked={!!draft.dailyDigestEnabled}
                onChange={(e) => update("dailyDigestEnabled", e.target.checked)} />
              <label htmlFor="digest-toggle" style={{ fontSize: 14 }}>
                Daily evening digest ("3 of 5 today")
              </label>
            </div>
          </>
        )}
      </div>
      <div style={{ ...styles.formCard, marginTop: 24 }}>
        <h2 style={styles.sectionTitle}>Live calendar subscription</h2>
        <p style={{ color: "#6B6B6B", margin: "4px 0 16px" }}>
          Subscribe once - your calendar app polls the ledger and stays current. Beats re-exporting .ics every change.
        </p>
        {webcal ? (
          <>
            <Field label="webcal:// URL" full>
              <input readOnly value={webcal} style={styles.input} onClick={(e) => e.target.select()} />
            </Field>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <a href={webcal} style={styles.primaryBtn}>
                <CalendarDays size={14} /> Subscribe on this device
              </a>
              <button style={styles.ghostBtn}
                onClick={() => { navigator.clipboard.writeText(webcal).catch(() => {}); }}>
                <Copy size={14} /> Copy
              </button>
            </div>
          </>
        ) : (<div style={{ color: "#8A8579", fontSize: 13 }}>Set the backend URL above first.</div>)}
      </div>
      <div style={styles.formActions}>
        <button onClick={save} style={styles.primaryBtn}>{saved ? "Saved" : "Save settings"}</button>
      </div>
    </div>
  );
}

/* BRAINSTORM CHAT */
function BrainstormView({ household, aiCfg, categories, frequencies, assigneeOptions, onAddTask, onAddTasks }) {
  const [conversation, setConversation] = useState([
    { role: "assistant", content: "Hi! Tell me what you're planning - a project, an event, a new routine, a season change, anything - and I'll help turn it into a clean list of tasks for the ledger. What's on your mind?" },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState([]);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conversation, busy]);

  const send = async () => {
    if (!input.trim() || busy) return;
    if (!aiCfg.enabled) {
      setError("Enable the AI agent in Settings > AI agent first. (And make sure ANTHROPIC_API_KEY is in your Apps Script Script Properties.)");
      return;
    }
    setError(null);
    const userMsg = { role: "user", content: input.trim() };
    const next = [...conversation, userMsg];
    setConversation(next);
    setInput("");
    setBusy(true);

    const r = await brainstormTasks({
      backendUrl: aiCfg.backendUrl, sharedSecret: aiCfg.sharedSecret,
      conversation: next, household, categories, frequencies,
    });
    setBusy(false);

    if (!r || r.error) {
      setError((r && r.error && r.error.message) || "AI couldn't respond. Try again.");
      return;
    }
    const replyParts = [r.reply || "Got it."];
    if (r.followUp) replyParts.push(r.followUp);
    setConversation([...next, { role: "assistant", content: replyParts.join("\n\n") }]);

    if (Array.isArray(r.proposedTasks) && r.proposedTasks.length > 0) {
      const stamped = r.proposedTasks.map((t, i) => ({
        ...t,
        _id: "p_" + Date.now() + "_" + i,
        _selected: true,
      }));
      setProposed(prev => [...prev, ...stamped]);
    }
  };

  const toggleSelect = (id) => setProposed(ps => ps.map(p => p._id === id ? { ...p, _selected: !p._selected } : p));
  const updateProposed = (id, patch) => setProposed(ps => ps.map(p => p._id === id ? { ...p, ...patch } : p));
  const removeProposed = (id) => setProposed(ps => ps.filter(p => p._id !== id));
  const addSelected = () => {
    const toAdd = proposed.filter(p => p._selected);
    if (toAdd.length === 0) return;
const stripped = toAdd.map(p => {
      const { _id, _selected, reasoning, ...task } = p;
      return task;
    });
    if (typeof onAddTasks === "function") {
      onAddTasks(stripped);
    } else {
      // Fallback if parent didn't pass onAddTasks — adds will be lossy
      // (stale-closure bug), but at least one task lands.
      stripped.forEach(task => onAddTask(task));
    }
    setProposed(ps => ps.filter(p => !p._selected));
    setConversation(c => [...c, {
      role: "assistant",
      content: "Added " + toAdd.length + " task" + (toAdd.length === 1 ? "" : "s") + " to the ledger. Want to brainstorm more, or are we good?",
    }]);
  };

  return (
    <div>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.sectionTitle}>Brainstorm with AI</h2>
          <p style={{ color: "#6B6B6B", fontSize: 14, margin: "4px 0 0" }}>
            Describe what you're planning. I'll ask follow-ups and propose a task list with category, frequency, and priority pre-filled.
          </p>
        </div>
      </div>

      <div style={styles.brainstormCard}>
        <div ref={scrollRef} style={styles.chatScroll}>
          {conversation.map((m, i) => (
            <div key={i} style={{ ...styles.chatBubble, ...(m.role === "user" ? styles.chatBubbleUser : styles.chatBubbleAi) }}>
              {m.role === "assistant" && <Sparkles size={12} color="#C9603C" style={{ marginRight: 6, marginTop: 3, flexShrink: 0 }} />}
              <div style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.content}</div>
            </div>
          ))}
          {busy && (
            <div style={{ ...styles.chatBubble, ...styles.chatBubbleAi }}>
              <Sparkles size={12} color="#C9603C" style={{ marginRight: 6, marginTop: 3 }} />
              <div style={{ flex: 1, fontStyle: "italic", color: "#8A8579" }}>thinking...</div>
            </div>
          )}
        </div>

        {error && (
          <div style={{ ...styles.errorBanner, margin: "12px 0 0" }}>
            <AlertCircle size={16} /> {error}
          </div>
        )}

        <div style={styles.chatInputRow}>
          <input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder='e.g. "We are moving into a new house next month"'
            style={{ ...styles.input, flex: 1 }} disabled={busy} />
          <button onClick={send} style={styles.primaryBtn} disabled={busy || !input.trim()}>
            <Send size={14} /> Send
          </button>
        </div>
      </div>

      {proposed.length > 0 && (
        <div style={{ ...styles.formCard, marginTop: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
            <h3 style={{ ...styles.categoryTitle, margin: 0 }}>
              Proposed tasks ({proposed.filter(p => p._selected).length} of {proposed.length} selected)
            </h3>
            <button style={styles.primaryBtn} onClick={addSelected} disabled={!proposed.some(p => p._selected)}>
              <Check size={14} /> Add selected to ledger
            </button>
          </div>
          {proposed.map(p => (
            <ProposedTaskCard key={p._id} task={p}
              categories={categories} frequencies={frequencies} assigneeOptions={assigneeOptions}
              onToggle={() => toggleSelect(p._id)}
              onChange={(patch) => updateProposed(p._id, patch)}
              onRemove={() => removeProposed(p._id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProposedTaskCard({ task, categories, frequencies, assigneeOptions, onToggle, onChange, onRemove }) {
  const [editing, setEditing] = useState(false);
  return (
    <div style={{ ...styles.proposedCard, opacity: task._selected ? 1 : 0.55 }}>
      <input type="checkbox" checked={!!task._selected} onChange={onToggle} style={{ marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {!editing ? (
          <>
            <div style={{ fontWeight: 600, color: "#1B2C3A", marginBottom: 4 }}>{task.title}</div>
            {task.details && <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 6 }}>{task.details}</div>}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "#8A8579" }}>
              <span>{task.assignedTo}</span>
              <span>· {task.frequency}</span>
              <span>· {task.priority}</span>
              <span>· {task.category}</span>
              {task.deadline && <span>· due {task.deadline}</span>}
            </div>
            {task.reasoning && (
              <div style={{ fontSize: 11, color: "#C9603C", marginTop: 6, fontStyle: "italic" }}>{task.reasoning}</div>
            )}
          </>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input value={task.title} onChange={(e) => onChange({ title: e.target.value })} style={{ ...styles.input, gridColumn: "1 / -1" }} />
            <textarea value={task.details || ""} onChange={(e) => onChange({ details: e.target.value })}
              rows={2} style={{ ...styles.input, gridColumn: "1 / -1", fontFamily: "inherit", resize: "vertical" }} />
            <select value={task.category} onChange={(e) => onChange({ category: e.target.value })} style={styles.input}>
              {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <select value={task.frequency} onChange={(e) => onChange({ frequency: e.target.value })} style={styles.input}>
              {frequencies.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <select value={task.assignedTo} onChange={(e) => onChange({ assignedTo: e.target.value })} style={styles.input}>
              {assigneeOptions.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={task.priority} onChange={(e) => onChange({ priority: e.target.value })} style={styles.input}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <input type="date" value={task.deadline || ""} onChange={(e) => onChange({ deadline: e.target.value || null })}
              style={{ ...styles.input, gridColumn: "1 / -1" }} />
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        <button style={styles.iconBtn} onClick={() => setEditing(e => !e)} title={editing ? "Done editing" : "Edit"}>
          {editing ? <Check size={14} /> : <Edit2 size={14} />}
        </button>
        <button style={{ ...styles.iconBtn, color: "#A04848" }} onClick={onRemove} title="Reject">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/* CELEBRATION */
function Celebration({ data }) {
  const isKid = !!data.isKid;
  return (
    <div style={styles.celebrationOverlay} key={data.key}>
      <div className={data.isMilestone ? "ledger-milestone" : "ledger-pop"} style={{
        ...styles.celebrationBox,
        ...(data.isMilestone ? styles.celebrationMilestone : {}),
        ...(isKid ? { background: "linear-gradient(135deg, #FAF7F2 0%, #E8F0E5 100%)", borderColor: "#5C7A3F" } : {}),
      }}>
        {isKid
          ? <div style={{ fontSize: data.isMilestone ? 44 : 32 }}>{(data.who && data.who.emoji) || "\u{1F389}"}</div>
          : <Flame size={data.isMilestone ? 36 : 24} color="#C9603C" strokeWidth={2.25} />}
        <div>
          <div style={{ fontFamily: "'Fraunces', serif", fontSize: data.isMilestone ? 28 : 20, fontWeight: 600, color: "#1B2C3A" }}>
            {isKid ? ("Nice one, " + (data.who && data.who.name) + "!") : (data.streak + " in a row")}
          </div>
          {isKid && (
            <div style={{ fontSize: 13, color: "#5C7A3F", fontWeight: 500, marginTop: 2 }}>
              That's {data.streak} {data.streak === 1 ? "time" : "in a row"}.
            </div>
          )}
          {data.isMilestone && !isKid && (
            <div style={{ fontSize: 13, color: "#C9603C", fontWeight: 500, marginTop: 2 }}>
              Milestone - keep the chain going.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* STYLES */
function FontStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,600&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');
      * { box-sizing: border-box; }
      body { margin: 0; }
      input, select, textarea, button { font-family: inherit; }
      input:focus, select:focus, textarea:focus { outline: 2px solid #C9603C !important; outline-offset: -2px; }
      button { cursor: pointer; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      select { appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%231B2C3A' stroke-width='2'><polyline points='6 9 12 15 18 9'/></svg>"); background-repeat: no-repeat; background-position: right 12px center; padding-right: 36px !important; }
      .ledger-checkbox:hover { transform: scale(1.08); transition: transform 0.15s; }
    `}</style>
  );
}

function KeyframeStyles() {
  return (
    <style>{`
      @keyframes ledger-streak-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
      .ledger-streak-pulse { animation: ledger-streak-pulse 2.2s ease-in-out infinite; }
      @keyframes ledger-pop-in {
        0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.7); }
        20%  { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
        40%  { transform: translate(-50%, -50%) scale(1); }
        80%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
      }
      .ledger-pop { animation: ledger-pop-in 1.5s ease-out forwards; }
      @keyframes ledger-milestone-in {
        0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.5) rotate(-8deg); }
        15%  { opacity: 1; transform: translate(-50%, -50%) scale(1.15) rotate(3deg); }
        30%  { transform: translate(-50%, -50%) scale(0.97) rotate(-1deg); }
        45%  { transform: translate(-50%, -50%) scale(1.03) rotate(0deg); }
        60%  { transform: translate(-50%, -50%) scale(1); }
        85%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
      }
      .ledger-milestone { animation: ledger-milestone-in 3s ease-out forwards; }
    `}</style>
  );
}

const styles = {
  shell: { minHeight: "100vh", backgroundColor: "#FAF7F2", fontFamily: "'DM Sans', system-ui, sans-serif", color: "#1B2C3A", position: "relative", paddingBottom: 80 },
  grain: { position: "fixed", inset: 0, pointerEvents: "none", opacity: 0.4, backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 0.1 0 0 0 0 0.1 0 0 0 0 0.1 0 0 0 0.06 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")" },
  loadingShell: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#FAF7F2" },
  container: { maxWidth: 1100, margin: "0 auto", padding: "40px 32px", position: "relative", zIndex: 1 },
  header: { marginBottom: 32 },
  headerTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24, marginBottom: 28, flexWrap: "wrap" },
  eyebrow: { fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "#8A8579", fontWeight: 500, marginBottom: 8 },
  title: { fontFamily: "'Fraunces', serif", fontWeight: 500, fontSize: "clamp(36px, 5vw, 56px)", lineHeight: 1.05, letterSpacing: "-0.02em", margin: 0 },
  scoreCard: { backgroundColor: "#1B2C3A", color: "#FAF7F2", padding: "16px 24px", borderRadius: 4, textAlign: "center", minWidth: 180 },
  scoreLabel: { fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", opacity: 0.7, marginBottom: 4 },
  scoreValue: { fontFamily: "'Fraunces', serif", fontSize: 36, fontWeight: 500, lineHeight: 1 },
  scoreDivider: { opacity: 0.4, margin: "0 4px" },
  scoreTotal: { opacity: 0.6 },
  scoreProgressTrack: { height: 3, backgroundColor: "rgba(250,247,242,0.15)", borderRadius: 2, marginTop: 10, overflow: "hidden" },
  scoreProgressFill: { height: "100%", backgroundColor: "#C9603C", transition: "width 0.4s ease" },
  scoreSub: { fontSize: 11, opacity: 0.65, marginTop: 6, letterSpacing: "0.05em" },
  nav: { display: "flex", gap: 4, borderBottom: "1px solid #E5DFD3", paddingBottom: 0, flexWrap: "wrap" },
  navBtn: { display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", border: "none", background: "transparent", fontSize: 14, color: "#6B6B6B", borderBottom: "2px solid transparent", marginBottom: "-1px", fontWeight: 500, transition: "color 0.15s" },
  navBtnActive: { color: "#1B2C3A", borderBottomColor: "#C9603C" },
  toggleGroup: { display: "flex", border: "1px solid #D9D2C4", borderRadius: 3, overflow: "hidden" },
  toggleBtn: { padding: "8px 14px", border: "none", background: "transparent", fontSize: 13, color: "#6B6B6B", fontWeight: 500 },
  toggleBtnActive: { backgroundColor: "#1B2C3A", color: "#FAF7F2" },
  sectionHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, gap: 16, flexWrap: "wrap" },
  sectionTitle: { fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 500, margin: 0, letterSpacing: "-0.01em" },
  quickAdd: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, padding: 14, marginBottom: 28, transition: "all 0.15s" },
  quickAddExpanded: { borderColor: "#C9603C", boxShadow: "0 0 0 3px rgba(201,96,60,0.08)" },
  quickAddRow: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  quickAddInput: { flex: 1, border: "none", outline: "none", fontSize: 15, padding: "6px 0", background: "transparent", color: "#1B2C3A", minWidth: 200 },
  quickAddOptions: { display: "flex", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid #F0EAE0", flexWrap: "wrap" },
  leaderboardCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, padding: 16, marginBottom: 28 },
  categorySection: { marginBottom: 36 },
  categoryHeader: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid #E5DFD3" },
  categoryDot: { width: 10, height: 10, borderRadius: "50%" },
  categoryTitle: { fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 500, margin: 0, flex: 1, textTransform: "capitalize" },
  categoryCount: { fontSize: 12, color: "#8A8579", fontVariantNumeric: "tabular-nums" },
  taskGrid: { display: "flex", flexDirection: "column", gap: 8 },
  taskCard: { display: "flex", alignItems: "flex-start", gap: 14, padding: "16px 18px", backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderLeftStyle: "solid", borderRadius: 4, transition: "all 0.15s", position: "relative" },
  taskCardDone: { backgroundColor: "#F2EDE4", opacity: 0.75 },
  checkbox: { width: 22, height: 22, border: "1.5px solid", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2, transition: "all 0.15s", padding: 0, background: "transparent" },
  taskTitleRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" },
  taskTitle: { fontSize: 15, fontWeight: 500, margin: 0, lineHeight: 1.3 },
  priorityHigh: { fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "#C9603C", fontWeight: 600, backgroundColor: "#FAEFEA", padding: "2px 8px", borderRadius: 2 },
  taskDetails: { fontSize: 13, color: "#6B6B6B", margin: "4px 0 8px", lineHeight: 1.5 },
  taskMeta: { display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: "#8A8579" },
  metaChip: { display: "inline-flex", alignItems: "center", gap: 4 },
  streakBadge: { display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", backgroundColor: "#FAEFEA", color: "#C9603C", borderRadius: 999, fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  primaryBtn: { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 18px", backgroundColor: "#1B2C3A", color: "#FAF7F2", border: "none", borderRadius: 3, fontSize: 14, fontWeight: 500, transition: "background 0.15s", textDecoration: "none" },
  ghostBtn: { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px", backgroundColor: "transparent", color: "#1B2C3A", border: "1px solid #C9C2B5", borderRadius: 3, fontSize: 13, fontWeight: 500, textDecoration: "none" },
  iconBtn: { width: 30, height: 30, border: "none", backgroundColor: "transparent", color: "#6B6B6B", borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s", padding: 0 },
  linkBtn: { background: "transparent", border: "none", color: "#C9603C", fontWeight: 500, cursor: "pointer", padding: "4px 8px", fontSize: 13, textDecoration: "underline" },
  snoozeMenu: { position: "absolute", top: 36, right: 0, backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, boxShadow: "0 4px 16px rgba(27,44,58,0.08)", padding: 8, minWidth: 200, zIndex: 10 },
  snoozeTitle: { fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#8A8579", fontWeight: 600, padding: "4px 8px 8px" },
  snoozeItem: { display: "block", width: "100%", padding: "8px 10px", border: "none", background: "transparent", textAlign: "left", fontSize: 13, color: "#1B2C3A", borderRadius: 3 },
  snoozeCustom: { display: "flex", gap: 4, padding: "8px 4px 4px", borderTop: "1px solid #F0EAE0", marginTop: 4 },
  snoozedPill: { display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", backgroundColor: "#F2EDE4", color: "#8A8579", borderRadius: 999, fontSize: 11, border: "none", cursor: "pointer" },
  filterBar: { display: "flex", gap: 24, marginBottom: 16, padding: "12px 16px", backgroundColor: "#F2EDE4", borderRadius: 4, flexWrap: "wrap" },
  filterGroup: { display: "flex", alignItems: "center", gap: 8 },
  filterLabel: { fontSize: 12, color: "#6B6B6B", fontWeight: 500 },
  select: { padding: "6px 32px 6px 10px", border: "1px solid #D9D2C4", borderRadius: 3, backgroundColor: "#FFFFFF", fontSize: 13, color: "#1B2C3A" },
  table: { width: "100%", borderCollapse: "collapse", backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, overflow: "hidden" },
  tableHeadRow: { backgroundColor: "#F2EDE4" },
  th: { textAlign: "left", padding: "10px 8px", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B6B6B", fontWeight: 600, borderBottom: "1px solid #E5DFD3", whiteSpace: "nowrap" },
  tableRow: { borderBottom: "1px solid #F0EAE0" },
  td: { padding: "10px 8px", fontSize: 13, color: "#1B2C3A", verticalAlign: "top" },
  categoryPill: { display: "inline-block", padding: "2px 10px", border: "1px solid", borderRadius: 999, fontSize: 11, fontWeight: 500, whiteSpace: "nowrap" },
  priorityPill: { display: "inline-block", padding: "2px 10px", backgroundColor: "#F2EDE4", color: "#6B6B6B", borderRadius: 999, fontSize: 11, textTransform: "capitalize" },
  priorityPillHigh: { backgroundColor: "#FAEFEA", color: "#C9603C" },
  priorityPillLow: { backgroundColor: "#F2EDE4", color: "#8A8579" },
  formCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, padding: 32 },
  formHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 },
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 },
  label: { display: "block", fontSize: 12, fontWeight: 500, color: "#6B6B6B", marginBottom: 6, letterSpacing: "0.02em" },
  input: { width: "100%", padding: "10px 12px", border: "1px solid #D9D2C4", borderRadius: 3, backgroundColor: "#FFFFFF", fontSize: 14, color: "#1B2C3A" },
  formActions: { display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 28, paddingTop: 24, borderTop: "1px solid #E5DFD3" },
  emailCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, overflow: "hidden" },
  emailMeta: { padding: "16px 24px", borderBottom: "1px solid #E5DFD3", backgroundColor: "#F2EDE4", display: "flex", flexDirection: "column", gap: 6, fontSize: 13 },
  emailMetaLabel: { fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "#8A8579", fontWeight: 600, marginRight: 12, minWidth: 60, display: "inline-block" },
  emailBody: { padding: 24, margin: 0, fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 14, lineHeight: 1.65, color: "#1B2C3A", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  emptyState: { textAlign: "center", padding: "80px 20px", backgroundColor: "#FFFFFF", border: "1px dashed #D9D2C4", borderRadius: 4 },
  errorBanner: { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", backgroundColor: "#FAEFEA", color: "#A04848", borderRadius: 3, fontSize: 13, marginBottom: 16 },
  conflictBanner: { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", backgroundColor: "#FAF1E0", color: "#8B6F2F", borderRadius: 3, fontSize: 13, marginBottom: 16, flexWrap: "wrap" },
  updateBanner: { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", backgroundColor: "#E8F0E5", color: "#3F5C25", borderRadius: 3, fontSize: 13, marginBottom: 16 },
  infoBox: { marginTop: 24, padding: 20, backgroundColor: "#F2EDE4", borderLeft: "3px solid #C9603C", borderRadius: 3, fontSize: 13, color: "#6B6B6B" },
  syncErrorPopover: { position: "absolute", top: 22, left: 12, backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, boxShadow: "0 4px 16px rgba(27,44,58,0.12)", padding: 12, minWidth: 260, zIndex: 20, fontSize: 12, color: "#1B2C3A" },
  insightGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 28 },
  insightCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, padding: 18 },
  insightLabel: { fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#8A8579", fontWeight: 500, marginBottom: 8 },
  insightValue: { fontFamily: "'Fraunces', serif", fontSize: 32, fontWeight: 500, lineHeight: 1, color: "#1B2C3A" },
  insightSub: { fontSize: 12, color: "#8A8579", marginTop: 6 },
  retroCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderLeft: "3px solid #C9603C", borderRadius: 4, padding: 24, marginBottom: 24 },
  retroSection: { fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#8A8579", fontWeight: 600, marginBottom: 6 },
  retroBullet: { fontSize: 14, color: "#1B2C3A", lineHeight: 1.5, marginBottom: 4 },
  retroSuggestion: { display: "flex", alignItems: "center", gap: 6, padding: 12, backgroundColor: "#FAEFEA", borderRadius: 3, color: "#1B2C3A", fontSize: 14, marginTop: 12 },
  brainstormCard: { backgroundColor: "#FFFFFF", border: "1px solid #E5DFD3", borderRadius: 4, padding: 18, display: "flex", flexDirection: "column", gap: 12 },
  chatScroll: { maxHeight: 480, minHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: 4 },
  chatBubble: { display: "flex", alignItems: "flex-start", padding: "10px 14px", borderRadius: 12, maxWidth: "85%", fontSize: 14, lineHeight: 1.5 },
  chatBubbleUser: { alignSelf: "flex-end", backgroundColor: "#1B2C3A", color: "#FAF7F2", borderBottomRightRadius: 4 },
  chatBubbleAi:   { alignSelf: "flex-start", backgroundColor: "#F2EDE4", color: "#1B2C3A", borderBottomLeftRadius: 4 },
  chatInputRow: { display: "flex", gap: 8, alignItems: "stretch", paddingTop: 12, borderTop: "1px solid #F0EAE0" },
  proposedCard: { display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", borderTop: "1px solid #F0EAE0", transition: "opacity 0.15s" },

  celebrationOverlay: { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" },
  celebrationBox: { position: "absolute", left: "50%", top: "50%", display: "flex", alignItems: "center", gap: 16, padding: "20px 28px", backgroundColor: "#FAF7F2", border: "2px solid #C9603C", borderRadius: 8, boxShadow: "0 20px 50px rgba(27,44,58,0.18)" },
  celebrationMilestone: { padding: "28px 40px", background: "linear-gradient(135deg, #FAF7F2 0%, #FAEFEA 100%)" },
};
