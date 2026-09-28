/*
 * The console's service worker, and all it does is show a push.
 *
 * It caches nothing and answers no request: the console is a live view of a
 * machine, and a copy of it served while the machine is unreachable would be
 * a screen of stale numbers pretending to be current. The manager sends the
 * words already in the reader's language, so this only has to put them up.
 */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { title: event.data ? event.data.text() : '' }; }
  var title = message.title || 'SillyTavern Manager';
  event.waitUntil(self.registration.showNotification(title, {
    body: message.body || '',
    tag: message.tag || undefined,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: message.url || '/' },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/';
  var absolute = new URL(target, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
    // The console already open in a tab is brought forward rather than opened twice.
    for (var index = 0; index < windows.length; index += 1) {
      var client = windows[index];
      if (new URL(client.url).origin === self.location.origin && absolute.indexOf(self.location.origin) === 0 && 'focus' in client) return client.focus();
    }
    return self.clients.openWindow ? self.clients.openWindow(absolute) : undefined;
  }));
});
