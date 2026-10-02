// This worker displays notifications requested by an open page. It does not
// schedule background work or claim to send reminders after the page is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const appRoot = new URL(self.registration.scope);
    const todayUrl = new URL('#today', appRoot).href;
    const client = clients.find(c => {
      const url = new URL(c.url);
      return url.origin === appRoot.origin && url.pathname.startsWith(appRoot.pathname);
    });
    if (client) { await client.navigate(todayUrl); return client.focus(); }
    return self.clients.openWindow(todayUrl);
  }));
});
