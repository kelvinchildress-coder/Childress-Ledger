/* sw-push.js — imported by Workbox at build time (see vite.config.js).
 * Adds the Web Push event handler the generated SW doesn't include by default.
 */

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Family Ledger", body: event.data ? event.data.text() : "Open the ledger." };
  }
  const title = payload.title || "Family Ledger";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag || "ledger",
    data: { url: payload.url || "/" },
    requireInteraction: !!payload.requireInteraction,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
