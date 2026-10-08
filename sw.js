// 사례관리 ON — 오프라인 설치용 서비스 워커.
// 이 앱은 서버·외부 API·CDN이 전혀 없는 단일 HTML 파일이므로, 그 파일 자체와
// 설치에 필요한 몇 개 파일만 캐시해 두면 이후 완전히 오프라인에서도 열린다.
// 실제 데이터는 이 워커가 아니라 IndexedDB(case_management_on.html 안)에 저장된다.
const CACHE_NAME = 'cmon-shell-v1';
const APP_SHELL = ['./case_management_on.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first, network-refresh-in-background: 오프라인에서도 즉시 열리고,
// 온라인일 때는 다음 방문을 위해 최신 버전으로 캐시를 갱신한다. 앱 화면(HTML)이
// 캐시된 것과 달라졌다면 열려 있는 창에 APP_UPDATED 메시지를 보내, 화면이
// "새 버전이 있습니다" 안내를 띄울 수 있게 한다(새로고침하면 갱신된 캐시로 열림).
async function notifyAppUpdated(){
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => client.postMessage({ type: 'APP_UPDATED' }));
}

async function refreshFromNetwork(request, cachedCopy){
  try{
    const response = await fetch(request);
    if (!response || response.status !== 200) return response;
    const isAppPage = new URL(request.url).pathname.endsWith('.html');
    const changed = isAppPage && cachedCopy
      ? (await cachedCopy.text()) !== (await response.clone().text())
      : false;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
    if (changed) await notifyAppUpdated();
    return response;
  }catch(err){
    return undefined;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // respondWith가 cached의 본문을 소비하므로, 비교용 복사본을 먼저 만들어 둔다.
      const refresh = refreshFromNetwork(event.request, cached ? cached.clone() : null);
      event.waitUntil(refresh);
      return cached || refresh.then((response) => response || Response.error());
    })
  );
});
