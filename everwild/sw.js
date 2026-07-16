const CACHE='everwild-v4-20260715';
const FALLBACK='./index.html';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['./manifest.webmanifest'])));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request,{cache:'no-store'}).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(FALLBACK,copy));return response;}).catch(()=>caches.match(FALLBACK)));
    return;
  }
  event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)));
});
