// Lets Chrome install Call Bridge as a desktop app. Nothing is cached: the app needs the live
// server anyway, and serving stale code would be worse than an offline page.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
