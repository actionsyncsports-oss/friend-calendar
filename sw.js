// Deliberately does NOT cache anything. This exists so browsers treat the site
// as an installable app, and to receive phone notifications; every page request still
// goes straight to the network, so an update is live the moment it deploys -- no stale
// copy to get stuck on.
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(){});

// A phone notification arrived (sent by the server on behalf of the database).
self.addEventListener('push', function(e){
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (er) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Friend Calendar', {
    body: d.body || '',
    tag: d.tag || undefined,          // a newer notification about the same chat/plan replaces the old one
    renotify: !!d.tag,
    icon: '/icons/icon-192.png',
    data: { url: d.url || '/' }
  }));
});

// Tapping it opens the app at the right place (the chat, plan or group it was about).
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);   // same-site only
  var open = target.searchParams.get('open') || '';
  e.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(list){
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
        return c.focus().then(function(cl){ if (cl && cl.postMessage) cl.postMessage({ type:'open', open:open }); return cl; });   // already running: just tell it where to go
      }
    }
    return self.clients.openWindow(target.href);
  }));
});
