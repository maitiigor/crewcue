// CrewCue service worker — shows pop-up cues even while Iriun is on screen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data?.text() || 'CrewCue' };
  }
  const title = data.title || 'CrewCue';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: true, // buzz again even if it replaces an earlier alert
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      vibrate: [200, 100, 200],
      data: { cueId: data.cueId || null },
    })
  );
});

// Tapping opens CrewCue (and confirms the cue). Note: on iPhone this pulls the
// operator out of Iriun, so crews should swipe banners away instead of tapping.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const cueId = event.notification.data?.cueId;
  const url = cueId ? `/?ack=${encodeURIComponent(cueId)}` : '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if ('focus' in w) {
          if (cueId) w.postMessage({ type: 'ack', cueId });
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    })()
  );
});
