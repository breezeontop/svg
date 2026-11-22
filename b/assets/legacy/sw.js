// Service worker for the Scramjet 1.1.0 engine (Settings > Proxy). Registered
// by boot.mjs with this folder as its scope, so it only ever sees proxied pages
// under ./p/ and never competes with the 2.x worker at the site root (the
// browser routes each request to the registration with the longest scope).
// Paths are relative to this file, which keeps it working at any base path.

if (navigator.userAgent.includes("Firefox")) {
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, writable: false });
}

importScripts("./sj.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Only the proxy prefix and the wasm (what boot.mjs configures) go through
// Scramjet; this folder's own files and everything else pass straight through
// without touching the config database.
const PROXIED = [new URL("p/", self.registration.scope).href, new URL("sj.wasm.wasm", self.registration.scope).href];

async function handle(event) {
  await scramjet.loadConfig();
  // No config yet means boot.mjs has not run init(): nothing can be proxied.
  if (scramjet.config && scramjet.route(event)) return scramjet.fetch(event);
  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  if (PROXIED.some((start) => event.request.url.startsWith(start))) event.respondWith(handle(event));
});

// boot.mjs asks for a fresh read after the controller saves its config, so a
// worker that cached an older config (another base path, an older build) does
// not keep routing with it. loadConfig() only reads when nothing is cached.
self.addEventListener("message", (event) => {
  if (!event.data || event.data.breeze$reloadConfig !== true) return;
  scramjet.config = null;
  event.waitUntil(
    scramjet
      .loadConfig()
      .catch(() => {})
      .then(() => event.ports[0]?.postMessage(true)),
  );
});
