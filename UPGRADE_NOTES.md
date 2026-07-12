# Family Ledger — Upgrade Notes (July 2026)

Seven upgrades were added on top of commit ce59cc6. The app builds cleanly
(npm run build -> 349 KB bundle, PWA service worker generated). Everything
degrades gracefully: new shared data falls back to on-device storage until the
backend is updated, and Google sign-in stays dormant until you add a Client ID.

## What changed

### 1. Tab reorder + nesting
Main tabs are now: Today - This Week - All Tasks - Brainstorm - Insights - Reminders - Settings.
- Sunday Email moved INSIDE the Settings tab.
- Calendar moved INSIDE the Reminders tab.

### 2. Holiday Mode
Settings -> Holiday Mode -> "Start Holiday Mode". While on, "home" tasks
(the House Care category) drop out of Today, This Week, and notifications.
Tap "We're home" to end it - the House Care tasks that came due while you were
away resurface as a catch-up list (banner on the Today tab). Nothing is lost.

### 3. Google sign-in (SSO)
- Set each family member's email in Settings -> People.
- Paste your OAuth Client ID in Settings -> Family sign-in (or set
  VITE_GOOGLE_CLIENT_ID at build time). Your Client ID:
  820673384341-2puite1greq2u34cu83o1l51tqqov20d.apps.googleusercontent.com
- Optionally tick "Require sign-in" to lock the app to allowlisted emails.
- On sign-in, each person is dropped into their own profile automatically.
- The client SECRET is never used by the front end - keep it private.

One-time Google Cloud step: in the OAuth Client, add your site to
"Authorized JavaScript origins": https://childress-ledger.vercel.app
(add http://localhost:5173 too if you run it locally).

### 4. New-day notifications
The first time someone opens the app each day, a banner lists their tasks due
today (with a View button to jump to Today). If push is enabled and granted on
that device, it also fires a local notification. Real background push still uses
your existing daily-digest push path in the backend.

### 5. Notes (per-person visibility)
On the Today tab: leave a note and choose who can see it - Everyone, one person,
or any combination. Each person only sees notes addressed to them. Authors can
delete their own notes.

### 6. "When Possible" shared list
On the Today tab: a separate, low-pressure shared list - no deadlines, no
scheduling, no notifications. Anyone can add an item or tick it off.

### 7. Subscriptions & Benefits tracker
Under the Reminders tab. Track two kinds of recurring things:
- Bills (money out) - see total monthly spend and what renews soon.
- Benefits (perks in, e.g. Chase Sapphire Reserve $150 StubHub credit every
  6 months) - the Maximize panel lists perks you haven't used this cycle, with
  "Mark used" and "Remind me" (drops a dated task into the ledger).

## Backend (Google Apps Script) - required for cross-device sync of #5-#7
backend/FamilyLedger.gs gained six actions: get-notes/save-notes,
get-when-possible/save-when-possible, get-subs/save-subs (stored as JSON in
Script Properties). Until you redeploy the Apps Script, Notes / When-Possible /
Subscriptions still work but only on the local device.

To enable sync: open your Apps Script project, replace FamilyLedger.gs with this
version, and Deploy -> Manage deployments -> Edit -> New version (keep
"Who has access = Anyone").

## New / changed files
- New: src/holiday.js, src/notes.js, src/whenPossible.js, src/googleAuth.js, src/subscriptions.js
- Changed: src/App.jsx, backend/FamilyLedger.gs, .env.example

## How to deploy
Commit these files to main on GitHub the way you normally do - Vercel builds and
publishes automatically. Optionally set VITE_GOOGLE_CLIENT_ID in the Vercel
project's Environment Variables so SSO works without pasting it in Settings.
