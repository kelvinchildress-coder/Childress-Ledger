# Deployment guide — end-to-end

Everything you need to get The Family Ledger fully wired up: PWA, backend, AI, push, calendar. Skip sections you don't want.

---

## Mental model

```
   PWA (Vercel/Netlify)
        │
        │ HTTPS
        ▼
   Apps Script (your Google account)
        ├──► Anthropic API           (AI features)
        ├──► Cloudflare Worker       (Web Push)  →  iOS/Android push
        └──► Gmail                   (Sunday email + reply parser)
```

Each line is independent. You can run with just the PWA + Apps Script + email — that already covers the original spec. AI and push are upgrades.

---

## 1. Deploy the PWA  (~3 min)

The fastest path is Vercel.

1. Push this folder to a new GitHub repo (private is fine).
2. https://vercel.com → **Add New → Project** → pick the repo.
3. Framework preset auto-detects as **Vite**. Don't change anything.
4. **Environment Variables** (skip if you'll paste the backend URL in Settings on each device):
   - `VITE_BACKEND_URL` = your Apps Script `/exec` URL (see step 2)
   - `VITE_SHARED_SECRET` = matches `SHARED_SECRET` in Apps Script (optional)
5. **Deploy**. You get a `family-ledger-pwa.vercel.app` URL within a minute.

On your phone:
- **iPhone (Safari):** Share → "Add to Home Screen"
- **Android (Chrome):** menu → "Install app"

The PWA is fully self-contained at this point. Skip ahead to step 2 to add a backend.

---

## 2. Set up the Google Sheet + Apps Script  (~5 min)

1. Create a new Google Sheet (any name).
2. Extensions → Apps Script. Delete the default `function myFunction()` stub.
3. Paste the contents of `backend/FamilyLedger.gs`.
4. Save.
5. Top toolbar → select `setupAll` → **Run**. Accept the permission prompts (it needs Spreadsheet, Mail, Gmail, ScriptApp).
6. **Deploy → New deployment → Web app:**
   - Execute as: **Me**
   - Who has access: **Anyone** (NOT "Anyone with Google account")
7. Copy the `/exec` URL.
8. Open the PWA → Settings → paste the URL into "Apps Script Web App URL" → **Test connection** → should say ✓ Connected.

The Sheet now has three tabs: `Tasks`, `Settings`, `PushSubs`. Edit `Settings` to set `parentEmails` (comma-separated) so the Sunday email knows where to go.

---

## 3. Enable AI features  (~2 min)

1. Get an Anthropic API key: https://console.anthropic.com → Settings → API Keys → Create key.
2. Open your Apps Script project → ⚙️ **Project Settings** → **Script properties** → Add:
   - Key: `ANTHROPIC_API_KEY`
   - Value: your key
3. Apps Script auto-applies new properties — no redeploy needed.
4. In the PWA → Settings → AI agent → check "Enable AI features". Save.
5. Try it: dashboard → Quick Add → type "schedule dentist" → click **AI Fill**.

Costs: a typical family hits ~30–50 calls per week. Claude Sonnet pricing at the time of writing puts that at single-cents/month.

---

## 4. Add a shared secret  (~1 min, optional)

The Apps Script URL is already secret, but if you're paranoid:

1. Apps Script → Script properties → add `SHARED_SECRET` = any random string (`openssl rand -base64 32` is fine).
2. PWA → Settings → "Shared secret" → paste the same string.
3. Save. Every request now includes `&secret=…` and Apps Script rejects everything else.

---

## 5. Enable Push notifications  (~10 min, optional)

Push requires a tiny external relay because Apps Script can't perform the VAPID signing.

1. **Generate VAPID keys** locally: `npx web-push generate-vapid-keys` (or use any online tool). Save both keys.
2. **Set up the Cloudflare Worker:**
   - https://dash.cloudflare.com → Workers & Pages → Create application → Hello World.
   - Replace the default code with `backend/push-relay.worker.js`.
   - On first deploy Cloudflare will prompt to add the npm dependency `@block65/webcrypto-web-push` — accept.
   - Settings → Variables:
     - `VAPID_PUBLIC_KEY` = public key from step 1
     - `VAPID_PRIVATE_KEY` = private key from step 1
     - `VAPID_SUBJECT` = `mailto:you@example.com`
     - `RELAY_BEARER` = random string
   - Deploy. Copy the `*.workers.dev` URL.
3. **Wire it to Apps Script:**
   - Script properties:
     - `PUSH_RELAY_URL` = your Worker URL
     - `PUSH_RELAY_TOKEN` = same as `RELAY_BEARER`
4. **Subscribe a device:**
   - PWA → Settings → Push notifications → paste the **VAPID public key** → click **Enable push**.
   - Accept the browser permission prompt.
5. **Test:**
   - In Apps Script, manually `Run` `sendWeeklyEmail` → your device should buzz.

iPhone notes: iOS 16.4+ is required, and the PWA must be **installed** (Add to Home Screen). Notifications won't fire from Safari proper.

---

## 6. Subscribe your calendar to live updates  (~30 sec, optional)

1. PWA → Settings → Live calendar subscription.
2. Click **Subscribe on this device** (uses `webcal://`), OR copy the URL and paste it into:
   - macOS Calendar: File → New Calendar Subscription
   - Google Calendar: Other calendars → From URL
   - Outlook: Add calendar → Subscribe from web
3. Your calendar polls the URL on its own schedule (usually 1–24h). Edits in the ledger flow into the calendar automatically.

---

## 7. Sunday morning workflow

Once everything's set up the loop is:

- **Sunday 7am:** Apps Script trigger fires `sendWeeklyEmail`. Both parents get a digest. Push notifications (if enabled) also fire.
- **During the week:** anyone can reply to the email with `ADD: / DONE: / SNOOZE: / EDIT: / DELETE:` commands. The reply parser runs every 10 minutes and applies them.
- **8pm daily:** the daily digest push fires ("3 of 5 done today, 2 still open") — opt-in via Settings.
- **Any device:** edits sync within ~1s in either direction. If two parents edit simultaneously, the conflict banner appears so neither edit is lost silently.

---

## Troubleshooting

| Symptom | First place to look |
|---|---|
| Test connection ✗ Failed | Click the error banner — the `hint` field tells you exactly what to fix. Most common: deployment access not "Anyone". |
| AI Fill says "AI couldn't help" | Either `ANTHROPIC_API_KEY` not set, or you hit the 60/hour rate limit. Apps Script Executions log shows the actual response. |
| Push notification didn't arrive | Apps Script Executions log → look for "Push relay response: 4xx". If 401, the bearer token doesn't match. If 410, the subscription is dead — re-enable in Settings. |
| Sunday email didn't send | Apps Script Triggers → confirm `sendWeeklyEmail` is installed. Settings tab in the Sheet → `parentEmails` populated. |
| Conflict banner won't go away | Click "Adopt remote" or "Keep my version". The decision sticks until the next divergence. |
| "New version ready — reload" stuck | That's the Workbox update prompt. Click "Reload now". |

For everything else, the **Copy debug info** button on any error gives you a JSON blob with the URL, error class, and UA — paste it into a new issue or chat.
