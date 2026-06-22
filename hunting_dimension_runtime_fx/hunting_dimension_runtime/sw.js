/*
 * 狩猟次元 PWA Service Worker
 * -----------------------------------------------------------------------------
 * 役割:
 *   - アプリシェル（HTML/CSS/JS/アイコン）とゲームデータ(JSON)をキャッシュし、
 *     オフラインでもホーム画面から起動・プレイできるようにする。
 *   - ネットワークがあれば取得したものを随時キャッシュへ反映（runtime cache）。
 *
 * 更新方法（将来的に更新しやすい構成）:
 *   - 配信ファイルを変更したら CACHE_VERSION を 1 つ上げるだけでよい。
 *     activate 時に古いキャッシュを破棄し、新しい内容へ自動更新される。
 *   - 即時更新したい場合はページ側から postMessage({type:'SKIP_WAITING'}) を送ると、
 *     待機中の新Workerが直ちに有効化される。
 *
 * ゲームロジック・確率・JSON構造には一切関与しない（配信物のキャッシュのみ）。
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = `hunting-dimension-pwa-${CACHE_VERSION}`;

// オフライン起動に必要な最小ファイル一式
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './assets/css/styles.css',
  './assets/js/data.js',
  './assets/js/app.js',
  './assets/icons/icon-192.svg',
  './assets/icons/icon-512.svg',
  './rules.json',
  './settings.json',
  './gacha.json',
  './weapons.json',
  './armor.json',
  './decorations.json',
  './events.json',
  './monsters.json',
  './inventory.json'
];

// インストール: アプリシェルを事前キャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// 有効化: 旧バージョンのキャッシュを破棄して更新
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ページからの指示で即時更新できるようにする
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 取得: キャッシュ優先 + 取得物の随時キャッシュ + オフライン時のフォールバック
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          // 正常な同一オリジンのレスポンスのみキャッシュへ保存
          if (!response || response.status !== 200 || response.type === 'opaque') {
            return response;
          }
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
          return response;
        })
        .catch(async () => {
          // オフラインでページ遷移要求なら index.html を返す（アプリ起動を維持）
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          throw new Error('offline');
        });
    })
  );
});
