import { buildCacheNames } from "./cache";
import { classifyRequest } from "./routes";

const APP_VERSION = "__TRW_APP_CACHE_VERSION__";
const DATA_VERSION = "__TRW_DATA_CACHE_VERSION__";
const PRECACHE_URLS = JSON.parse("__TRW_PRECACHE_JSON__") as string[];
const CACHE_NAMES = buildCacheNames(APP_VERSION, DATA_VERSION);

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

interface WorkerScopeLike extends EventTarget {
  clients: { claim(): Promise<void> };
  location: Location;
  registration: ServiceWorkerRegistration;
  skipWaiting(): Promise<void>;
}

const worker = globalThis as unknown as WorkerScopeLike;
const indexUrl = new URL("./index.html", worker.registration.scope).toString();

worker.addEventListener("install", (event) => {
  const installEvent = event as ExtendableEventLike;
  installEvent.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAMES.shell);
    const urls = PRECACHE_URLS.map((path) => new URL(path, worker.registration.scope).toString());
    await cache.addAll(urls);
  })());
});

worker.addEventListener("activate", (event) => {
  const activateEvent = event as ExtendableEventLike;
  activateEvent.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith("trw-") && name !== CACHE_NAMES.shell && name !== CACHE_NAMES.runtime)
      .map((name) => caches.delete(name)));
    await worker.clients.claim();
  })());
});

worker.addEventListener("message", (event) => {
  const message = event as MessageEvent<{ type?: string }>;
  if (message.data?.type === "SKIP_WAITING") void worker.skipWaiting();
});

worker.addEventListener("fetch", (event) => {
  const fetchEvent = event as FetchEventLike;
  const route = classifyRequest(fetchEvent.request, worker.registration.scope);
  if (route === "ignore") return;

  fetchEvent.respondWith((async () => {
    const cacheKey = route === "navigation" ? indexUrl : fetchEvent.request;
    const cached = await caches.match(cacheKey);
    if (cached) return cached;

    try {
      const response = await fetch(fetchEvent.request);
      if (response.ok && new URL(fetchEvent.request.url).origin === worker.location.origin) {
        const runtime = await caches.open(CACHE_NAMES.runtime);
        await runtime.put(fetchEvent.request, response.clone());
      }
      return response;
    } catch (error) {
      if (route === "navigation") {
        const shell = await caches.open(CACHE_NAMES.shell);
        const offlinePage = await shell.match(indexUrl);
        if (offlinePage) return offlinePage;
      }
      throw error;
    }
  })());
});
