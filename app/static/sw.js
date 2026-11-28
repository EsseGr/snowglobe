// Caches the static app shell. API and photos always go to the network.
const CACHE = "snowglobe-v2";
const BASE = "%BASE%";
const SHELL = ["/static/style.css", "/static/app.js", "/static/globe.js", "/static/i18n.js",
  "/static/vendor/three.module.min.js", "/static/vendor/RoomEnvironment.js", "/static/icon.svg"].map((p) => BASE + p);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (!url.pathname.startsWith(BASE + "/static/")) return;  // pages & API: network only
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })
  );
});
