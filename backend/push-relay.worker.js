/**
 * push-relay.worker.js — Cloudflare Worker that delivers Web Push messages.
 *
 * Why this exists:
 *   Apps Script can't perform the ECDH/HKDF crypto required to send VAPID-signed
 *   Web Push messages. A tiny Worker is the simplest answer — free tier handles
 *   100k requests/day, way more than a family needs.
 *
 * Deploy in ~5 minutes:
 *   1. https://dash.cloudflare.com → Workers & Pages → Create application → Hello World template
 *   2. Replace the entire worker code with this file's contents
 *   3. Under Settings → Variables, set:
 *        VAPID_PUBLIC_KEY   = (from `npx web-push generate-vapid-keys`)
 *        VAPID_PRIVATE_KEY  = (same command)
 *        VAPID_SUBJECT      = mailto:you@example.com
 *        RELAY_BEARER       = a random string you'll also put in Apps Script PUSH_RELAY_TOKEN
 *   4. Deploy → copy the *.workers.dev URL into Apps Script Script Properties PUSH_RELAY_URL.
 *
 * The Worker accepts:
 *   POST /
 *   Authorization: Bearer <RELAY_BEARER>
 *   { "subscriptions": [PushSubscription, ...], "payload": { "title", "body", "url", "tag" } }
 */

import { buildPushPayload } from "@block65/webcrypto-web-push"; // pinned in wrangler.toml

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    // Auth
    const auth = request.headers.get("Authorization") || "";
    if (!env.RELAY_BEARER || auth !== "Bearer " + env.RELAY_BEARER) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body;
    try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
    const subs = body.subscriptions || [];
    const payload = body.payload || {};
    if (subs.length === 0) return Response.json({ ok: true, delivered: 0 });

    const vapid = {
      publicKey:  env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject:    env.VAPID_SUBJECT,
    };

    let delivered = 0;
    const results = await Promise.allSettled(subs.map(async (sub) => {
      const message = JSON.stringify(payload);
      const req = await buildPushPayload(
        { data: message, options: { ttl: 60 * 60 * 24 } },
        sub,
        vapid,
      );
      const res = await fetch(req);
      if (res.status >= 200 && res.status < 300) delivered++;
      return res.status;
    }));
    return Response.json({ ok: true, delivered, total: subs.length, statuses: results.map(r => r.value || r.reason?.message) });
  },
};
