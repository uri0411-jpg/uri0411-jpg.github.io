const CACHE='twilight-sunset-v1';
const PRECACHE=[
  './','./index.html','./spot.html','./privacy-policy.html','./offline.html',
  './manifest.webmanifest','./css/app.css',
  './js/app.js','./js/sun.js','./js/favorites.js','./js/forecast.js','./js/notifications.js','./js/spotfinder.js',
  './icons/icon-192.png','./icons/icon-512.png',
  './assets/backgrounds/hero-golden-hour.png','./assets/backgrounds/hero-bright-pastel.png',
  './assets/spots/spot-mountain.png','./assets/spots/spot-coast.png','./assets/spots/spot-forest.png','./assets/spots/spot-desert.png'
];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(k=>k===CACHE?null:caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(res=>{
    const copy=res.clone(); caches.open(CACHE).then(c=>c.put(e.request,copy)); return res;
  }).catch(()=>caches.match('./offline.html'))));
});
