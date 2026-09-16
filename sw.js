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
// 온라인일 때는 다음 방문을 위해 최신 버전으로 캐시를 갱신한다.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request).then((response) => {
        if (response && response.status === 200){
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
