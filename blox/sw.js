// Service worker for /blox/. Roblox's web client talks to *.roblox.com and
// *.rbxcdn.com with ordinary fetch/XHR, from the page and from its pthread
// workers. Those hosts may be unreachable from here, so every cross-origin
// request is handed to a page in this scope, which sends it over Wisp
// (host.js) with the Roblox session attached, and the reply comes back here.
//
// Served by our server (server/blox.ts), same-origin requests are left alone:
// the server already sends the cross-origin isolation headers the engine's
// SharedArrayBuffer needs, and has the engine.
//
// Registered as sw.js?standalone (the CDN build, index.svg), it stands in for
// that server, since a static host sends no such headers and has no engine:
// - every page in scope is index.html, answered with the isolation headers;
// - engine/… is fetched from the API server named by the page's ?api=, which
//   must be one of BACKENDS (scripts/build-svg.mjs fills it in from
//   backends.json), so a crafted link cannot load an engine from elsewhere;
// - every other file of ours gets the isolation headers too.

const SCOPE = new URL(self.registration.scope);
const STANDALONE = new URL(self.location.href).searchParams.has("standalone");
const BACKENDS = ["https://mathematics.kristenblackburnvolleyballcamps.com","https://mathematics.southpadreislandkiteboarding.com","https://mathematics.bananadogstore.com","https://mathematics.aplusmartialarts-templehills.com","https://mathematics.actingoutdoor.com","https://mathematics.restorecounselingcenter.org"];
// WasmPlayer.js loads the engine's flags from here. The engine on disk is one
// pinned version, so it gets the flags fetched alongside it, not whatever
// Roblox's live flags are for a newer engine.
const PINNED_FLAGS = "PinnedFlags.json";
const FLAGS_URL = /^https:\/\/clientsettingscdn\.roblox\.com\/v2\/settings\/application\/WebClientApp(?:\/bucket\/[^?#]*)?(?:[?#]|$)/;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const RELAY_TIMEOUT_MS = 120_000;
const ISOLATION = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};
const TYPES = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  otf: "font/otf",
  png: "image/png",
  ttf: "font/ttf",
  wasm: "application/wasm",
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!/^https?:/.test(request.url)) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    event.respondWith(crossOrigin(request, event.clientId));
  } else if (STANDALONE && url.href.startsWith(SCOPE.href) && url.pathname !== self.location.pathname) {
    event.respondWith(ownFile(request, url));
  }
});

// ---- Standalone: the files a server would serve ------------------------------

const CONFIG_CACHE = "blox-config";
const API_KEY = new URL("__api", SCOPE).href;
let api = null;

function allowedApi(value) {
  try {
    const origin = new URL(value).origin;
    return BACKENDS.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}

// Remembered in Cache Storage, since the browser stops idle workers: a game
// started from the launcher (?placeId= only) still knows where the engine is.
async function rememberApi(value) {
  const origin = allowedApi(value);
  if (!origin || origin === api) return;
  api = origin;
  const cache = await caches.open(CONFIG_CACHE);
  await cache.put(API_KEY, new Response(origin));
}

async function currentApi() {
  if (api) return api;
  const cache = await caches.open(CONFIG_CACHE);
  const saved = await cache.match(API_KEY);
  api = allowedApi(saved ? await saved.text() : "") ?? BACKENDS[0] ?? null;
  return api;
}

function typeOf(pathname) {
  const ext = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase();
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : null;
}

function isolated(response, contentType) {
  const headers = new Headers();
  headers.set("content-type", contentType ?? response.headers.get("content-type") ?? "application/octet-stream");
  for (const name of ["last-modified", "etag"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "no-cache");
  for (const [name, value] of Object.entries(ISOLATION)) headers.set(name, value);
  const body = NULL_BODY.has(response.status) ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function failure(status, message) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", ...ISOLATION } });
}

async function engineFile(request, relative) {
  const base = await currentApi();
  if (!base) return failure(502, "No backend to load the Roblox engine from.");
  try {
    const upstream = await fetch(`${base}/blox/engine/${relative}`, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      mode: "cors",
      credentials: "omit",
      signal: request.signal,
    });
    return isolated(upstream, typeOf(relative));
  } catch (error) {
    return failure(502, `Couldn't load the Roblox engine from ${base}: ${error?.message || error}`);
  }
}

async function ownFile(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return fetch(request);
  const relative = url.pathname.slice(SCOPE.pathname.length);
  if (relative.startsWith("engine/")) return engineFile(request, relative.slice("engine/".length));
  try {
    // Any page here is the host page (index.svg included, once this worker
    // runs: it only registered this worker). Static hosts may send .html as
    // text/plain, so the type is set here.
    if (request.mode === "navigate") {
      const given = url.searchParams.get("api");
      if (given) await rememberApi(given);
      return isolated(await fetch(new URL("index.html", SCOPE), { cache: "no-cache" }), TYPES.html);
    }
    return isolated(await fetch(request), typeOf(url.pathname));
  } catch (error) {
    return failure(502, String(error?.message || error));
  }
}

// ---- Relay --------------------------------------------------------------------

async function pinnedFlags() {
  if (STANDALONE) return engineFile(new Request(SCOPE), PINNED_FLAGS);
  return fetch(new URL(`engine/${PINNED_FLAGS}`, SCOPE), { cache: "no-cache" });
}

async function crossOrigin(request, clientId) {
  if (request.method === "GET" && FLAGS_URL.test(request.url)) {
    const pinned = await pinnedFlags().catch(() => null);
    if (pinned?.ok) return reply(200, "", [["content-type", "application/json"]], await pinned.arrayBuffer());
  }
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    const result = await relay(clientId, {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body,
    });
    return reply(result.status, result.statusText, result.headers, result.body);
  } catch (error) {
    return reply(502, "Bad Gateway", [["content-type", "application/json"]], JSON.stringify({ error: String(error?.message || error) }));
  }
}

function reply(status, statusText, headers, body) {
  const out = new Headers(headers);
  // The page is cross-origin isolated (COEP require-corp): without this, any
  // no-cors load (an <img>) of a relayed response would be blocked.
  out.set("cross-origin-resource-policy", "cross-origin");
  // The engine fetches with credentials and reads headers such as
  // x-csrf-token, so answer as Roblox would to its own site.
  out.set("access-control-allow-origin", self.location.origin);
  out.set("access-control-allow-credentials", "true");
  const names = [...new Set([...out.keys()])].join(", ");
  if (names) out.set("access-control-expose-headers", names);
  return new Response(NULL_BODY.has(status) ? null : body, { status, statusText, headers: out });
}

// A page of ours in this scope. Requests from the engine's workers carry the
// worker's client id, so fall back to any window.
async function relayPage(clientId) {
  const own = clientId ? await self.clients.get(clientId) : null;
  if (own?.type === "window") return own;
  const pages = await self.clients.matchAll({ type: "window" });
  const page = pages.find((client) => client.frameType === "top-level") ?? pages[0];
  if (!page) throw new Error("no page to relay through");
  return page;
}

async function relay(clientId, message) {
  const page = await relayPage(clientId);
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("relay timed out"));
    }, RELAY_TIMEOUT_MS);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (data.ok) resolve(data);
      else reject(new Error(data.error));
    };
    const transfer = message.body ? [channel.port2, message.body] : [channel.port2];
    page.postMessage({ type: "blox-fetch", ...message }, transfer);
  });
}
