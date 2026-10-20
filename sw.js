// Podium Service Worker
// Enables offline functionality and PWA installation

const CACHE_NAME = 'podium-v2.3.0-a83e8004fcd1';
// Relative to this script, so Podium works when served from a subdirectory.
// The packaged page is podium.html where Podium is deployed alongside the rest
// of the site, and index.html where the deployment is Podium alone, so try both
// and keep whichever exists: addAll would reject the whole install if either
// were missing.
const urlsToCache = [
  './',
  './podium.html',
];
// The static-host build replaces this with the guidebook and its images, which
// that deployment carries, so the guidebook reads offline like the rest of the
// app. The videos are deliberately absent: they are 11.5 MB against 2.5 MB for
// every image, they are already preload="none" in the guidebook, and the fetch
// handler below leaves media to the network entirely.
const docToCache = [
  './Guidebook.ja.html',
  './assets/appabout.webp',
  './assets/appcells.webp',
  './assets/appcurtain.webp',
  './assets/appscreen.webp',
  './assets/appstorage.webp',
  './assets/appwakelock.webp',
  './assets/imslp.webp',
  './assets/inkcells.webp',
  './assets/inkedit.webp',
  './assets/inkgrid.webp',
  './assets/inkpencilpen.webp',
  './assets/inkrastrum.webp',
  './assets/inksymbols.webp',
  './assets/inktext.webp',
  './assets/inktransform1.webp',
  './assets/inktransform2.webp',
  './assets/interfacelocking.webp',
  './assets/interfacerotating.webp',
  './assets/interfacesliders.webp',
  './assets/layoutbook.webp',
  './assets/layoutcells.webp',
  './assets/layouthorizontal.webp',
  './assets/layoutphone.webp',
  './assets/layouttable.webp',
  './assets/layoutvertical.webp',
  './assets/morecells.webp',
  './assets/moredetach.webp',
  './assets/morekeyboard.webp',
  './assets/moremetronome.webp',
  './assets/moremetronomeopts.webp',
  './assets/morepiano.webp',
  './assets/morepianodetect.webp',
  './assets/morepianooptions.webp',
  './assets/moreprogressive.webp',
  './assets/morereviewoptions.webp',
  './assets/morereviewvideo.webp',
  './assets/morereviewwave.webp',
  './assets/morestopwatch.webp',
  './assets/pageadd.webp',
  './assets/pagecells.webp',
  './assets/pageimport.webp',
  './assets/pagemagnify.webp',
  './assets/pagemagnifymordent.webp',
  './assets/pagenumbers.webp',
  './assets/podium-icon.webp',
  './assets/pwa.webp',
  './assets/quickannotate.webp',
  './assets/quicklayout1.webp',
  './assets/quicklayout2.webp',
  './assets/quicklayout3.webp',
  './assets/quicklayout4.webp',
  './assets/quickmenu.webp',
  './assets/quickopen.webp',
  './assets/quickpage.webp',
  './assets/quicksave.webp',
  './assets/quicktools.webp',
  './assets/scorecells.webp',
  './assets/scoredetails.webp',
  './assets/scorenew.webp',
  './assets/scoreopen.webp',
  './assets/scoreprint.webp',
  './assets/scoresave.webp',
];

// Install event - cache resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Podium: Cache opened');
        return Promise.all([...urlsToCache, ...docToCache]
          .map((url) => cache.add(url).catch(() => {})));
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Podium: Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
    .then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  // Only handle GET requests — never intercept POST/PUT/etc. (e.g. OAuth token exchanges)
  if (event.request.method !== 'GET') return;

  // Leave media alone: do not answer it, do not cache it. A <video> is fetched
  // with Range requests, which arrive as 206 responses, and the Cache API
  // rejects those outright in cache.put(); worse, caches.match() ignores the
  // Range header, so a whole-file entry would be handed back as the answer to a
  // request for one byte range. Returning without respondWith() leaves the
  // browser's own media stack to do it, which is the only thing here that
  // understands partial content. The guidebook's videos are online-only by
  // design -- see docToCache above.
  if (event.request.destination === 'video' || event.request.destination === 'audio' ||
      /\.(webm|mp4|m4a|ogg|mp3|wav)$/i.test(new URL(event.request.url).pathname)) return;

  // Never cache the manifest - always fetch fresh
  if (event.request.url.endsWith('manifest.json') || event.request.url.endsWith('manifest.webmanifest')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Cache hit - return response from cache
        if (response) {
          return response;
        }
        // Clone the request
        const fetchRequest = event.request.clone();

        return fetch(fetchRequest).then((response) => {
          // Check if valid response
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }

          // Clone the response
          const responseToCache = response.clone();

          // Only cache same-origin requests (not external PDFs), and never a
          // request carrying a query string (e.g. the "?t=" cache-buster the
          // in-app restart button appends): caching those would accumulate a
          // new, never-reused entry in Cache Storage on every restart. Skipping
          // them keeps the canonical (no-query) entry set only at install time,
          // so it stays pinned until a real service worker update ships.
          if (event.request.url.startsWith(self.location.origin) && !new URL(event.request.url).search) {
            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              });
          }

          return response;
        });
      })
  );
});
