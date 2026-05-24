# The Family Ledger — PWA  (v2)

Installable, offline-capable, AI-assisted, self-improving family task ledger. Runs as a standalone app on iPhone / Android / desktop, syncs to a Google Sheet, sends a Sunday morning email (and an optional daily push), and uses Claude to auto-categorise new tasks and write weekly retrospectives.

For the full picture of what's in this version, see `CHANGELOG.md`.
For a step-by-step setup, see `DEPLOYMENT.md`.
For the Cowork context map, see `ONBOARDING.md`.

---

## What's inside in one screen

| Concern | How it works |
|---|---|
| Storage | IndexedDB locally + Google Sheet remotely. Last-write-wins with conflict banner. |
| Offline | Workbox caches the app shell. Failed POSTs queue for 24h and replay when back online. |
| Cross-device sync | Apps Script Web App URL pasted once (or baked in via `VITE_BACKEND_URL`). |
| Install | "Add to Home Screen" on phone, real icon, fullscreen. |
| Sunday email | Apps Script trigger at 7am Sunday. HTML + text. Push notification too if relay is configured. |
| Reply parser | `ADD: / DONE: / SNOOZE: / EDIT: / DELETE:` commands, processed every 10 min. |
| AI agent | Claude proxied through Apps Script — key never touches the browser. Auto-categorise, deadline parsing, weekly retrospective. |
| Self-improving | Local 1000-event log feeds: smart dropdown ordering, stale-task detection, snooze patterns, repeat-task suggestions. |
| Identity | First-launch "Who am I" picker, per-person completions, weekly leaderboard, kid-themed celebrations. |
| Calendar | One-tap `webcal://` subscription that updates itself. .ics export still works as a fallback. |
| Push notifications | VAPID + Cloudflare Worker relay. Daily digest opt-in. |

---

## Run it locally (5 minutes)

You need Node 18+ installed.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Edit, refresh, things persist.

To build for production:

```bash
npm run build
npm run preview    # serves the built bundle locally on :4173
```

The `preview` step matters for testing the service worker — it doesn't register in dev mode.

---

## Deploy free in ~3 minutes (Vercel)

1. Push this folder to a new GitHub repo (private is fine).
2. https://vercel.com → **Add New → Project**, pick the repo.
3. Framework preset auto-detects as **Vite**.
4. *(Optional but recommended)* Project settings → Environment Variables:
   - `VITE_BACKEND_URL` = your Apps Script `/exec` URL — every device picks it up automatically.
   - `VITE_SHARED_SECRET` = if you set `SHARED_SECRET` in Apps Script.
5. **Deploy.** You get `family-ledger-pwa.vercel.app` within a minute.

Then on your phone:

- **iPhone (Safari):** Share → "Add to Home Screen"
- **Android (Chrome):** menu → "Install app" or "Add to Home screen"

---

## Connect to your Google Sheet + Apps Script

The Apps Script is in `backend/FamilyLedger.gs`. Step-by-step in `DEPLOYMENT.md`. The short version:

1. New Google Sheet → Extensions → Apps Script → paste `FamilyLedger.gs` → Save.
2. Run `setupAll` once. Accept the permission prompts.
3. Deploy → New deployment → Web app → Execute as Me, access **Anyone**.
4. Copy the `/exec` URL into the PWA Settings.

The Sheet auto-creates `Tasks`, `Settings`, `PushSubs` tabs and installs the Sunday-email + reply-parser + daily-digest triggers.

---

## Enable AI features

`DEPLOYMENT.md` walks through it. TL;DR:

1. Get a key at https://console.anthropic.com.
2. Apps Script → Project settings → Script properties → `ANTHROPIC_API_KEY` = your key.
3. PWA → Settings → AI agent → check "Enable AI features".
4. Quick-add a task → click **AI Fill**.

The key never touches the browser. Apps Script enforces 60 calls/hour so nothing can run away with it.

---

## File map

```
family-ledger-pwa/
├── README.md
├── ONBOARDING.md            # For Claude/Cowork agents picking up the project
├── DEPLOYMENT.md            # End-to-end setup guide
├── CHANGELOG.md             # What's new in v2
├── .env.example             # VITE_BACKEND_URL + VITE_SHARED_SECRET template
├── package.json
├── vite.config.js           # PWA manifest + Workbox runtime caching + background sync
├── index.html
├── public/
│   ├── favicon.svg
│   ├── icon-{192,512,512-maskable}.png
│   └── sw-push.js           # SW push + notificationclick handlers
├── backend/
│   ├── FamilyLedger.gs      # Apps Script backend
│   ├── push-relay.worker.js # Optional Cloudflare Worker for Web Push
│   └── README.md            # Backend setup notes
└── src/
    ├── main.jsx
    ├── App.jsx              # ~1800-line single-file UI (by design)
    ├── storage.js           # IndexedDB wrapper
    ├── sync.js              # Apps Script HTTP client with rich error classification
    ├── identity.js          # "Who am I" + per-person stats
    ├── ai.js      