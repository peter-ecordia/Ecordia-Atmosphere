'use strict';
/*
  Ecordiargus's service worker (scope: the whole site). Spec: Ecordiargus.
  - Keeps the app's own files, so Ecordiargus opens with no signal. Each file is fetched fresh when there is a signal
    (falling back to the saved copy after a few seconds), so an update arrives the next time it is opened online.
  - Background sync: sends what is waiting (sealed to the server, so no passcode is needed) when the signal is back,
    even if Ecordiargus has been closed. Where the browser has no background sync (iPhone and iPad), the page sends it
    when Ecordiargus is next opened with a signal.
  - Drafts left 14 days go to Ecordiatlas unfinished, on the same occasions.
  The API is never cached.
*/
importScripts('store.js');

const CACHE = 'argus-v6';   // (was atmosphere-v5; the old copy is cleared on activate)
const SHELL = ['/', '/atmosphere.js', '/store.js', '/base.css', '/atmosphere.css', '/theme.js', '/config.json', '/manifest.json',
  '/icon.svg', '/icon-192.png', '/icon-512.png', '/ecordiargus-logo-light.png', '/ecordiargus-logo-dark.png'];
const NETWORK_WAIT_MS = 4000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Ecordiargus's own files only: calls to Ecordiatlas's API (another site) always go to the network.
const isShell = url => url.origin === location.origin && url.pathname !== '/healthz';

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !isShell(url) || url.pathname.endsWith('/sw.js')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // The page itself, whatever its query (?tenant=, ?recover=1), is /.
    const key = e.request.mode === 'navigate' ? '/' : url.pathname;
    const network = fetch(e.request).then(res => {   // (the server marks these files no-cache, so this checks for a newer copy)
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    });
    network.catch(() => null);   // (a late failure after the saved copy was used)
    const saved = await cache.match(key);
    if (!saved) return network;
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), NETWORK_WAIT_MS));
    try { return (await Promise.race([network, timeout])) || saved; }
    catch { return saved; }
  })());
});

/** Expire, send, and tell any open Ecordiargus pages what happened. */
async function sendNow(reason) {
  await Atmosphere.expire();
  const result = await Atmosphere.sendOutbox();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'atmosphere:sent', reason, result });
  // Background sync tries again later if something is still waiting for a signal.
  if (result.noSignal) throw new Error('No signal yet');
  return result;
}

self.addEventListener('sync', e => { if (e.tag === 'atmosphere-send') e.waitUntil(sendNow('sync')); });
self.addEventListener('periodicsync', e => { if (e.tag === 'atmosphere-check') e.waitUntil(sendNow('periodic').catch(() => null)); });
self.addEventListener('message', e => { if (e.data?.type === 'atmosphere:send') e.waitUntil(sendNow('page').catch(() => null)); });
