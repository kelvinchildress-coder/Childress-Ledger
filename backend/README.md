# Backend (Apps Script + optional Push Relay)

This directory holds files you copy into Google Apps Script and (optionally) Cloudflare Workers. They are not part of the React build.

## Files

| File | Where it goes |
|---|---|
| `FamilyLedger.gs` | Paste into Apps Script project bound to your Google Sheet |
| `push-relay.worker.js` | Paste into a Cloudflare Worker (only if you want push notifications) |

## Apps Script setup (5 minutes)

1. Open your Family Ledger Google Sheet.
2. Extensions → Apps Script. Delete the default `function myFunction()` stub.
3. Paste the entire contents of `FamilyLedger.gs`.
4. Save.
5. **Run `setupAll` once** (top toolbar → select `setupAll` → Run). Accept the permission prompts.
6. **Deploy → New deployment → Web app:**
   - Execute as: **Me**
   - Who has access: **Anyone** (not "Anyone with Google account")
7. Copy the `/exec` URL — that's your Apps Script Web App URL.
8. Paste it into the PWA Settings page (or set `VITE_BACKEND_URL` in Vercel for a baked-in default).

## Script Properties (Project Settings → Script properties)

All optional; the app degrades gracefully without them.

| Key | What it enables |
|---|---|
| `ANTHROPIC_API_KEY` | AI features: auto-categorise tasks, weekly retrospective, natural-language deadline parsing |
| `SHARED_SECRET` | Adds a `&secret=` check on every request. Set this in the PWA Settings too. |
| `PUSH_RELAY_URL` | Web Push (Sunday 7am + daily digest) instead of email-only |
| `PUSH_RELAY_TOKEN` | Bearer token your relay validates |

## Push relay setup (optional, 5 minutes)

Skip this if email is enough. Push notifications are nicer on phones because they bypass spam filters and show on the lock screen.

1. Generate VAPID keys locally: `npx web-push generate-vapid-keys`
2. https://dash.cloudflare.com → Workers & Pages → Create → "Hello World" template.
3. Replace the worker code with `push-relay.worker.js`.
4. Add a `wrangler.toml` dependency for `@block65/webcrypto-web-push` (Cloudflare's Worker editor will prompt to add an npm dependency on first deploy).
5. Settings → Variables: set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto:you@example.com), `RELAY_BEARER` (any random string).
6. Deploy → copy the `*.workers.dev` URL.
7. In Apps Script Script Properties: `PUSH_RELAY_URL` = that URL, `PUSH_RELAY_TOKEN` = `RELAY_BEARER` value.
8. In the PWA → Settings → Push notifications: paste your `VAPID_PUBLIC_KEY`, click **Enable push**.
