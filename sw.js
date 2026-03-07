// sw.js - stable PWA SW for GitHub Pages project sites
const CACHE = "twilight-v8";
const PRECACHE = [
  "./",
  "./index.html",
  "./spot.html",
  "./manifest.json",
  "./css/app.css",
  "./js/app.js",
  "./js/sun.js",
  "./js/favorites.js",
  "./js/forecast.js",
  "./js/notifications.js",
  "./js/spotfinder.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./offline.html",
  "./privacy-policy.html"
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))))
    )
  );
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          })
          .catch(() => caches.match("./offline.html"));
      })
    );
    return;
  }
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes("index.html") || c.url.endsWith("/"));
      if (existing) return existing.focus();
      return clients.openWindow("./index.html");
    })
  );
});
