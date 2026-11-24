// Deliberately does NOT cache anything. This exists so browsers treat the site
// as an installable app; every request still goes straight to the network, so
// an update is live the moment it deploys -- no stale copy to get stuck on.
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(){});
