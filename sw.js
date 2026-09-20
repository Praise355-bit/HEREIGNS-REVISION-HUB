/* Revision Hub AI — optional service worker.
   Drop this file at the root of your site (next to index.html) and the app
   picks it up automatically. It does two things:

   1. Lets notifications be shown through the service worker registration,
      which is what keeps them alive when the tab is in the background or
      the window is minimised (and on Android, when the browser is closed).
   2. Makes a notification click focus an existing tab instead of opening
      a duplicate one, and deep-links to the right page.

   The app works fine without this file — it falls back to page-level
   notifications, which only fire while the tab is open somewhere. */

const APP_SCOPE = './';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const page = (event.notification.data && event.notification.data.page) || 'dashboard';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'navigate', page });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(APP_SCOPE);
    })
  );
});

/* Optional: if you later add Web Push from your Vercel backend, payloads
   shaped like { "title": "...", "body": "...", "page": "dashboard" } will
   show up here, and will arrive even with every tab closed on desktop. */
self.addEventListener('push', (event) => {
  let payload = { title: 'Revision Hub AI', body: 'Time to revise.', page: 'dashboard' };
  try { if (event.data) payload = Object.assign(payload, event.data.json()); } catch {}
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag || 'revision-hub-push',
      data: { page: payload.page }
    })
  );
});
