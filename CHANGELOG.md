# Changelog

## v2.0.0 — full automation + AI + self-improvement

Closes every item on the v1 TODO backlog (P0 → P2) and adds AI agent assistance plus a self-improving insights surface.

### New

**Persistence + sync**
- `VITE_BACKEND_URL` + `VITE_SHARED_SECRET` env vars baked into the build, falling through to Settings.
- Workbox **background sync queue** for failed POSTs — retried for 24h once back online.
- **Conflict detection** via per-task `lastModified` stamps. "Newer remote — adopt or keep?" banner instead of silent overwrites.
- 60-second background refresh from the Sheet so multi-device edits show up without a manual reload.
- Rich `{ error: { kind, message, hint } }` from every fetch wrapper; click-to-expand details and **"Copy debug info"** for one-shot bug reports.
- New `?action=ping` cheap-round-trip endpoint for connection testing.

**Identity + attribution**
- First-launch **"Who am I" picker** (parent/kid + emoji).
- Every completion stamps `completionLog: [{ date, by }]`.
- **Weekly leaderboard** strip on the dashboard.
- **Personal daily streak** card in Insights.
- **Kid-themed celebration** overlay when the active identity is a kid.

**Notifications**
- Web Push end-to-end: VAPID + `sw-push.js` + Settings flow.
- **Daily evening digest** opt-in ("3 of 5 done today").
- Cloudflare Worker push-relay scaffold (`backend/push-relay.worker.js`).

**Calendar**
- Live `webcal://` subscription served by Apps Script `?action=ics` — one tap to subscribe, no re-export needed.

**AI agent (Claude, proxied through Apps Script)**
- **AI Fill** in Quick Add: title → category + frequency + priority + assignee + deadline.
- **Deadline phrase parser** in Task Form: "next Friday" / "end of month" → ISO.
- **Weekly retrospective** generator in Insights: wins, drift, one suggestion.
- Anthropic key stays in Script Properties — never touches the browser.
- Server-side rate limiting (60 calls/hour) so a runaway loop can't drain credits.

**Self-improving heuristics (no AI needed)**
- Quick-add category and frequency dropdowns reorder by 30-day-decayed usage.
- Stale-task list (no completion in 30+ days) in Insights.
- Snooze-pattern detector flags tasks always pushed by the same number of days.
- Repeat-quick-add detector suggests promoting one-offs to recurring after 3+ adds.
- 1000-event rolling log persisted to IndexedDB.

**New Insights view** with throughput trend (this vs last vs prior week), personal streak, stale count, detected patterns, and the AI retrospective.

**Apps Script backend (full rewrite)**
- Added `PushSubs` sheet for subscription endpoints.
- New actions: `ping`, `ai`, `ics`, `subscribe-push`.
- `lastModified` written on every save.
- Optional `SHARED_SECRET` enforcement on every request.
- `sendDailyDigest` + `processReplies` + `sendWeeklyEmail` triggers installed in one `setupAll()` call.
- HTML version of the Sunday email so it renders cleanly on phones.

**PWA polish**
- `registerSW({ immediate: true })` plus an in-app **"new version ready — reload"** banner.
- Manifest `shortcuts` for jump-to-dashboard and jump-to-add from the home-screen icon.

### Fixed

- Apps Script test-connection bug: removed explicit `mode: "cors"`, added 8s timeout via `AbortController`, structured error responses.
- Email reply parser now also writes to `completionLog` (was only updating `completionHistory`).
- Empty-category sections no longer render in the Sunday email.

### Changed

- Storage key bumped to `family_ledger_v3` (migration handles v2 data).
- Task schema gained `completionLog`, `lastModified` (additive; old tasks migrated on load).
- Settings shape gained `sharedSecret`, `aiEnabled`, `vapidPublicKey`, `pushEnabled`, `dailyDigestEnabled`.

### Files added

```
.env.example
CHANGELOG.md
DEPLOYMENT.md
public/sw-push.js
src/sync.js
src/identity.js
src/ai.js
src/insights.js
src/push.js
backend/FamilyLedger.gs
backend/push-relay.worker.js
backend/README.md
```

### Migration

Drop the contents of this folder over your v1 install (or `git pull`) and re-`npm install`. Existing IndexedDB data migrates on next load — no data loss. To activate the new backend features, re-paste `backend/FamilyLedger.gs` into your Apps Script project and re-run `setupAll()` to install the daily-digest trigger.
