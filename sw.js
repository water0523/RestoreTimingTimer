/* timing 计时器的 Service Worker
 *
 * 为什么需要它：
 *   GitHub Pages 给静态资源的响应头是 cache-control: max-age=600，
 *   也就是浏览器缓存只保 10 分钟；而计时器是每 20 分钟才切一张背景图，
 *   所以每次切图时那张图都已经"过期"，必须重新走一次网络（至少一次往返）。
 *   网络一抖，表现就是"图片加载不出来"。
 *
 * 这里做的事：
 *   - 背景图（/images/*）：cache-first —— 装进 Cache Storage 后不受 max-age 限制，
 *     永久留在本地。线上体验因此和本地文件一样，开发者模式来回跳也是秒切，断网也能用。
 *   - 页面本身：network-first —— 保证每次都能拿到最新版本，网络不可用时回退到缓存。
 *
 * ⚠️ 维护提示：改了 images/ 下的图片后，请把下面的 CACHE_VERSION 加一，
 *    否则老访客的 Service Worker 会继续用缓存里的旧图。
 */

const CACHE_VERSION = 'v1';
const IMAGE_CACHE = `timing-images-${CACHE_VERSION}`;
const PAGE_CACHE = `timing-pages-${CACHE_VERSION}`;

self.addEventListener('install', () => {
    // 新版本立刻接管，不用等所有旧页面关闭
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter((key) => key !== IMAGE_CACHE && key !== PAGE_CACHE)
                .map((key) => caches.delete(key))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;   // 只管本站资源（GitHub API 等一律不碰）

    // 1) 背景图：缓存优先，永久有效
    if (url.pathname.includes('/images/')) {
        event.respondWith((async () => {
            const cache = await caches.open(IMAGE_CACHE);
            const cached = await cache.match(request, { ignoreSearch: true });
            if (cached) return cached;
            try {
                const response = await fetch(request);
                if (response && response.ok) {
                    cache.put(request, response.clone()).catch(() => {});
                }
                return response;
            } catch (err) {
                return cached || Response.error();
            }
        })());
        return;
    }

    // 2) 页面：网络优先（保证拿到新版本），失败时回退缓存（断网也能用）
    const isPage = request.mode === 'navigate'
        || url.pathname.endsWith('/')
        || url.pathname.endsWith('.html');
    if (isPage) {
        event.respondWith((async () => {
            const cache = await caches.open(PAGE_CACHE);
            try {
                const response = await fetch(request);
                if (response && response.ok) {
                    cache.put(request, response.clone()).catch(() => {});
                }
                return response;
            } catch (err) {
                const cached = await cache.match(request);
                if (cached) return cached;
                throw err;
            }
        })());
    }
});
