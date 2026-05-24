/* =====================================================================
 *  push.js — Web Push subscription helpers
 * =====================================================================
 *
 * Flow:
 *   1. requestPushPermission() asks the browser for notification perms.
 *   2. subscribeToPush(vapidKey) registers with the SW and returns a
 *      PushSubscription object.
 *   3. The caller sends that subscription up to Apps Script via
 *      registerPushSubscription() in sync.js.
 *   4. Apps Script (or the relay you point it at) calls web-push to
 *      send notifications.
 *
 * Apple/iOS notes:
 *   - Requires iOS 16.4+ AND the PWA must be installed (not just opened
 *     in Safari).
 *   - Notification permission must be requested in response to a user
 *     gesture (button click), not page load.
 */

export function isPushSupported() {
  return typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

export async function requestPushPermission() {
  if (!isPushSupported()) return { granted: false, reason: "Push not supported on this device/browser." };
  if (Notification.permission === "granted") return { granted: true };
  if (Notification.permission === "denied")
    return { granted: false, reason: "You previously blocked notifications. Reset in browser settings." };
  const result = await Notification.requestPermission();
  return { granted: result === "granted", reason: result === "granted" ? null : "Permission not granted." };
}

function urlBase64ToUint8Array(b64) {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

export async function subscribeToPush(vapidPublicKey) {
  if (!isPushSupported()) return { ok: false, error: "Push not supported." };
  if (!vapidPublicKey) return { ok: false, error: "Missing VAPID public key." };
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) return { ok: true, subscription: existing.toJSON() };
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    return { ok: true, subscription: sub.toJSON() };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

export async function unsubscribeFromPush() {
  if (!isPushSupported()) return { ok: false };
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getPushStatus() {
  if (!isPushSupported()) return { supported: false };
  let permission = Notification.permission;
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    subscribed = !!sub;
  } catch {}
  return { supported: true, permission, subscribed };
}
