const CACHE="y2y2-shell-v4";
const SHELL=["/","/styles.css","/relay.css","/app.js","/engine-client.js","/relay-client.js","/manifest.webmanifest","/icon.svg"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener("activate",event=>event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))])));
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith("/api/"))return;
  event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)));
});
