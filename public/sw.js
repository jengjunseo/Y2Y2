const CACHE="y2y2-pure-web-lab-v2";
const OPAQUE_CACHE="y2y2-opaque-probes-v1";
const SHELL=["/","/styles.css","/app.js","/manifest.webmanifest","/icon.svg","/lab/","/lab/lab.css","/lab/lab.js"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener("activate",event=>event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))])));
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;
  event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)));
});
self.addEventListener("message",event=>{
  if(event.data?.type!=="Y2Y2_OPAQUE_PROBE"||!event.ports?.[0])return;
  const port=event.ports[0];
  event.waitUntil((async()=>{
    try{
      const url=new URL(String(event.data.url||""));
      if(url.protocol!=="https:")throw new Error("HTTPS URL only");
      const response=await fetch(url,{mode:"no-cors",credentials:"omit",cache:"no-store"});
      const before={type:response.type,status:response.status,body:response.body,headers:[...response.headers].length};
      const cache=await caches.open(OPAQUE_CACHE);
      await cache.put(url.toString(),response.clone());
      const cached=await cache.match(url.toString());
      port.postMessage({ok:true,before,cached:cached?{type:cached.type,status:cached.status,body:cached.body,headers:[...cached.headers].length}:null});
    }catch(error){
      port.postMessage({ok:false,error:String(error?.message||error)});
    }
  })());
});
