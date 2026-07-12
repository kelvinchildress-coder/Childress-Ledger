/* =====================================================================
 *  googleAuth.js — Google Sign-In (SSO) for the family
 * =====================================================================
 *
 *  Uses Google Identity Services (GIS). A family member signs in with
 *  Google; we decode the returned ID token to get their email, then map
 *  that email to a household profile (parent or kid). Only allowlisted
 *  family emails are accepted.
 *
 *  Setup (one-time, done by the owner):
 *    1. In Google Cloud Console, create an OAuth 2.0 Client ID (type:
 *       Web application). Add the app origin to "Authorized JavaScript
 *       origins" (e.g. https://childress-ledger.vercel.app).
 *    2. Put the Client ID in VITE_GOOGLE_CLIENT_ID (build env) or paste
 *       it in Settings. The client SECRET is NOT used and must stay
 *       private.
 *    3. Fill each family member's email in Settings so sign-ins map to
 *       the right profile.
 *
 *  Nothing here runs until a Client ID is configured, so the app keeps
 *  working with the per-device identity picker in the meantime.
 */

export const GOOGLE_CLIENT_ID =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_GOOGLE_CLIENT_ID) || "";

const GIS_SRC = "https://accounts.google.com/gsi/client";
let _scriptPromise = null;

/** Effective Client ID: Settings value wins, else build-time env. */
export function getClientId(settings) {
  return (settings && settings.googleClientId) || GOOGLE_CLIENT_ID || "";
}

export function isGoogleAuthConfigured(settings) {
  return !!getClientId(settings);
}

/** Load the Google Identity Services script exactly once. */
export function loadGisScript() {
  if (_scriptPromise) return _scriptPromise;
  _scriptPromise = new Promise((resolve, reject) => {
    if (typeof document === "undefined") return reject(new Error("no document"));
    if (window.google && window.google.accounts && window.google.accounts.id) return resolve(window.google);
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => reject(new Error("Failed to load Google sign-in script"));
    document.head.appendChild(s);
  });
  return _scriptPromise;
}

/** Decode the payload of a Google ID token (JWT). No verification here. */
export function decodeJwt(token) {
  try {
    const part = token.split(".")[1];
    const json = decodeURIComponent(
      atob(part.replace(/-/g, "+").replace(/_/g, "/"))
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Initialize GIS and render a Sign in with Google button into `element`.
 * onResult receives { ok, profile?, email?, error? } where profile is the
 * matched household member (or null if the email isn't on the allowlist).
 */
export async function initGoogleAuth({ clientId, element, settings, onResult }) {
  if (!clientId) return { ok: false, error: "No Google Client ID configured." };
  try {
    const google = await loadGisScript();
    google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        const payload = decodeJwt(response.credential);
        if (!payload || !payload.email) {
          onResult && onResult({ ok: false, error: "Could not read Google account." });
          return;
        }
        const email = String(payload.email).toLowerCase();
        const member = matchEmailToMember(email, settings);
        onResult &&
          onResult({
            ok: !!member,
            email,
            name: payload.name,
            picture: payload.picture,
            credential: response.credential,
            profile: member,
            error: member ? null : `${email} isn't on the family allowlist.`,
          });
      },
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    if (element) {
      google.accounts.id.renderButton(element, {
        theme: "outline",
        size: "large",
        type: "standard",
        text: "signin_with",
        shape: "pill",
        logo_alignment: "left",
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** Sign the current user out of GIS auto-select. */
export function googleSignOut() {
  try {
    if (window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.disableAutoSelect();
    }
  } catch {}
}

/**
 * Map an email to a household member using the Settings roster.
 * Returns { name, role, email } or null if not allowlisted.
 */
export function matchEmailToMember(email, settings) {
  if (!email || !settings) return null;
  const e = String(email).toLowerCase().trim();
  const parentNames = settings.parentNames || [];
  const parentEmails = settings.parentEmails || [];
  const kidNames = settings.kidNames || [];
  const kidEmails = settings.kidEmails || [];

  for (let i = 0; i < parentEmails.length; i++) {
    if (parentEmails[i] && parentEmails[i].toLowerCase().trim() === e) {
      return { name: parentNames[i] || "Parent", role: "parent", email: e };
    }
  }
  for (let i = 0; i < kidEmails.length; i++) {
    if (kidEmails[i] && kidEmails[i].toLowerCase().trim() === e) {
      return { name: kidNames[i] || "Kid", role: "kid", email: e };
    }
  }
  return null;
}

/** True if ANY family email is configured (needed for the allowlist to work). */
export function hasRoster(settings) {
  const pe = (settings?.parentEmails || []).filter(Boolean);
  const ke = (settings?.kidEmails || []).filter(Boolean);
  return pe.length + ke.length > 0;
}
