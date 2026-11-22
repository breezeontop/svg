// Host page for Roblox's own browser client (binary type WebClientApp, pulled
// into vendor/webblox/engine by scripts/fetch-webblox.mjs).
//
// 1. Answers sw.js: every cross-origin request the engine makes arrives here
//    and goes out over Wisp through epoxy, which runs TLS in this page, so the
//    Wisp server never sees the session. Cookies live in a jar in localStorage.
// 2. Takes the Roblox session (.ROBLOSECURITY) from breeze's browser, where
//    you signed in to roblox.com, or asks for it.
// 3. Boots WasmPlayer.js the way Roblox's WasmLoader.js does, pointed at the
//    engine on this server.
//
// ?placeId=<id> joins that experience (&gameInstanceId=<job id> one server of
// it); without a place the page is a launcher. roblox.com's Play button opens
// this page through src/pages/browser/blox.ts.
//
// The same files also ship in the CDN build (scripts/build-svg.mjs), next to the
// app; there sw.js?standalone does the server's part (see sw.js).

const ROOT = new URL("./", import.meta.url);
const ENGINE_BASE = new URL("engine", ROOT).href;
const WISP_KEY = "blox.wisp";
const JAR_KEY = "blox.cookies";
const MANUAL_KEY = "blox.manual";
// ?placeId=…&gameInstanceId=…: join that server of the place (roblox.com's
// Join on a server or a friend). The id is a job id, a UUID in practice.
const JOIN_SERVER = (() => {
  const params = new URLSearchParams(location.search);
  const placeId = params.get("placeId");
  const serverId = params.get("gameInstanceId");
  return placeId && serverId && /^[A-Za-z0-9-]{1,64}$/.test(serverId) ? { placeId, serverId } : null;
})();
const SESSION = ".ROBLOSECURITY";
const SESSION_PREFIX = "_|WARNING:-DO-NOT-SHARE-THIS.";
const SESSION_CHECK = "https://users.roblox.com/v1/users/authenticated";
const ROBLOX_HOST = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com)$/i;
// Dropped from what the engine sent: the browser's own values describe this
// page, not www.roblox.com, and epoxy sets length and host itself.
const DROP_REQUEST = new Set(["cookie", "content-length", "host", "origin", "referer", "connection"]);
// Dropped from what Roblox sent: epoxy already decoded the body, the cookies
// went into the jar, and the CORS and isolation headers are set by sw.js.
const DROP_RESPONSE = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie",
  "access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-headers",
  "access-control-allow-methods", "access-control-expose-headers", "cross-origin-opener-policy",
  "cross-origin-embedder-policy", "cross-origin-resource-policy", "strict-transport-security",
]);

const status = document.getElementById("status");
const say = (text) => {
  status.textContent = text;
};

// ---- Wisp transport ---------------------------------------------------------

// Breeze opens this page with ?wisp=<the server it resolved> (it may be on
// another origin, so localStorage cannot carry it). The page remembers it for
// the joins that follow. Opened directly, it falls back to the app's own
// defaults (resolveWispServer in src/lib/browser-url.ts): a public server in
// development, where nothing serves /wind/, and this server's /wind/ otherwise.
const DEV_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]", "::1"];
const DEV_WISP_SERVER = "wss://anura.pro/";

function wispUrl() {
  const url = new URL(location.href);
  const given = url.searchParams.get("wisp");
  if (given !== null) {
    if (/^wss?:\/\//i.test(given)) localStorage.setItem(WISP_KEY, given);
    url.searchParams.delete("wisp");
  }
  // ?api= is for sw.js, which read it from the navigation, and ?boot is
  // index.svg's (CDN build only).
  url.searchParams.delete("api");
  url.searchParams.delete("boot");
  if (url.href !== location.href) history.replaceState(history.state, "", url);
  const stored = localStorage.getItem(WISP_KEY);
  if (stored && /^wss?:\/\//i.test(stored)) return stored;
  if (DEV_HOSTNAMES.includes(location.hostname)) return DEV_WISP_SERVER;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wind/`;
}

const WISP = wispUrl();
// Epoxy waits forever on a Wisp server that never answers; give up instead.
const REQUEST_TIMEOUT_MS = 30_000;

const transport = (async () => {
  const { default: EpoxyTransport } = await import(new URL("epoxy.mjs", ROOT).href);
  const epoxy = new EpoxyTransport({ wisp: WISP });
  await epoxy.init();
  return epoxy;
})();

// ---- Cookie jar ---------------------------------------------------------------
// { name, value, domain, hostOnly, path, expires (ms, 0 = session) }

function readJar() {
  try {
    const jar = JSON.parse(localStorage.getItem(JAR_KEY) || "[]");
    return Array.isArray(jar) ? jar.filter((c) => !c.expires || c.expires > Date.now()) : [];
  } catch {
    return [];
  }
}

function writeJar(jar) {
  localStorage.setItem(JAR_KEY, JSON.stringify(jar));
}

function domainMatches(host, cookie) {
  return host === cookie.domain || (!cookie.hostOnly && host.endsWith(`.${cookie.domain}`));
}

function pathMatches(path, cookiePath) {
  return path === cookiePath || path.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

function cookieHeader(url) {
  return readJar()
    .filter((c) => domainMatches(url.hostname, c) && pathMatches(url.pathname, c.path))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function putCookie(jar, cookie) {
  const kept = jar.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
  if (!cookie.expires || cookie.expires > Date.now()) kept.push(cookie);
  return kept;
}

function parseSetCookie(url, line) {
  const [pair, ...attributes] = line.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: url.hostname,
    hostOnly: true,
    path: "/",
    expires: 0,
  };
  let maxAge = null;
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at < 0 ? "" : attribute.slice(at + 1).trim();
    if (key === "domain" && value) {
      const domain = value.replace(/^\./, "").toLowerCase();
      // A host may only set cookies for itself or a parent domain.
      if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return null;
      cookie.domain = domain;
      cookie.hostOnly = false;
    } else if (key === "path" && value.startsWith("/")) {
      cookie.path = value;
    } else if (key === "expires") {
      const time = Date.parse(value);
      if (Number.isFinite(time)) cookie.expires = time;
    } else if (key === "max-age" && /^-?\d+$/.test(value)) {
      maxAge = Number(value);
    }
  }
  // Max-Age wins over Expires; zero or less deletes the cookie.
  if (maxAge !== null) cookie.expires = maxAge <= 0 ? 1 : Date.now() + maxAge * 1000;
  return cookie;
}

// `manual`: pasted here rather than taken from breeze's browser.
function storeSession(value, manual) {
  let jar = readJar().filter((c) => c.name !== SESSION);
  jar = putCookie(jar, { name: SESSION, value, domain: "roblox.com", hostOnly: false, path: "/", expires: 0 });
  writeJar(jar);
  localStorage.setItem(MANUAL_KEY, manual ? "1" : "0");
}

function forgetSession() {
  writeJar(readJar().filter((c) => c.name !== SESSION));
}

const savedSession = () => readJar().find((c) => c.name === SESSION)?.value ?? null;

// ---- Requests -----------------------------------------------------------------

// gamejoin treats "Roblox/Web …" as the browser player, which many
// experiences (DOORS among them) haven't enabled: they answer status 12 "You
// are not allowed to play this game. (Playtesters Only)". Joining as the
// Windows app, as lucideon.top's deployment does, is let in like the desktop
// client. The engine's agent reads "Roblox/Web <platform> (…; Linux) Browser/…
// RobloxApp/<version> (GlobalDist; RobloxDirectDownload)"; keep the app part.
function desktopAgent(agent) {
  const app = /RobloxApp\/\S+(?: \([^)]*\))?/.exec(agent)?.[0];
  return app ? `Roblox/WinInet ${app}` : "Roblox/WinInet";
}

// Roblox's game servers are reached over WebTransport at *.qdmux.roblox.com.
// gamejoin returns that name (gameFqdn) to the web client; to a desktop agent
// it returns the UDMUX relay and a net stack token instead, from which the
// name is derived (a rule taken from the same deployment).
function qdmuxFqdn(joinScript) {
  const udmux = joinScript.UdmuxEndpoints?.[0];
  const netStackToken = String(joinScript.NetStackTokenValue || "");
  if (!udmux || !netStackToken || !joinScript.MachineAddress || !joinScript.NetStackPort) return null;
  let token = netStackToken.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(token)) {
    try {
      token = [...atob(netStackToken)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }
  if (token.length !== 32) return null;
  const relay = String(udmux.Address).split(".").map(Number);
  const machine = String(joinScript.MachineAddress).split(".").map(Number);
  const octets = (list) => list.length === 4 && list.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!octets(relay) || !octets(machine)) return null;
  relay[3] += 1;
  if (relay[3] > 255) return null;
  const hex = (list) => list.map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${token}-${hex(machine)}-${Number(joinScript.NetStackPort).toString(16)}.${hex(relay)}.qdmux.roblox.com`;
}

// Logs what gamejoin answered (never the tokens) so a failed join, such as
// "no available transport", shows which part of the join script was missing.
function withGameFqdn(target, status, body) {
  let json = null;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {}
  const script = json?.joinScript;
  const fqdn = script && !script.gameFqdn ? qdmuxFqdn(script) : null;
  // One line of JSON, so a copied console still shows it (Chrome collapses objects).
  console.info("[blox] gamejoin", target.pathname, status, JSON.stringify({
    status: json?.status,
    message: json?.message,
    joinScript: Boolean(script),
    gameFqdn: Boolean(script?.gameFqdn) ? "from Roblox" : fqdn ? "derived" : "missing",
    udmux: Boolean(script?.UdmuxEndpoints?.length),
    netStackToken: Boolean(script?.NetStackTokenValue),
    machine: Boolean(script?.MachineAddress && script?.NetStackPort),
  }));
  if (!fqdn) return body;
  script.gameFqdn = fqdn;
  return new TextEncoder().encode(JSON.stringify(json)).buffer;
}

// Roblox's flags tell WasmPlayer.js to render with WebGPU, and it fails to
// start where there is none (Firefox outside Windows, older Chrome), although
// it still has a WebGL renderer. There, turn the preference off.
function withoutWebGpu(body) {
  if ("gpu" in navigator) return body;
  try {
    const json = JSON.parse(new TextDecoder().decode(body));
    if (!json?.applicationSettings) return body;
    json.applicationSettings.FFlagWasmPreferWebGPU = "False";
    return new TextEncoder().encode(JSON.stringify(json)).buffer;
  } catch {
    return body;
  }
}

// roblox.com's Join on a server or a friend names one server (game instance).
// The engine always asks gamejoin for any server of the place; for that
// place's first join (not a teleport), ask for the named one instead.
function joinNamedServer(target, body) {
  if (!JOIN_SERVER || target.pathname !== "/v1/join-game" || !body) return body;
  try {
    const request = JSON.parse(new TextDecoder().decode(body));
    if (String(request.placeId) !== JOIN_SERVER.placeId || request.isTeleport) return body;
    target.pathname = "/v1/join-game-instance";
    return new TextEncoder().encode(JSON.stringify({ ...request, gameId: JOIN_SERVER.serverId })).buffer;
  } catch {
    return body;
  }
}

async function upstream({ url, method, headers, body }) {
  const target = new URL(url);
  const out = new Map();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (!DROP_REQUEST.has(key) && !key.startsWith("sec-")) out.set(key, value);
  }
  const roblox = ROBLOX_HOST.test(target.hostname);
  const gameJoin = roblox && target.hostname === "gamejoin.roblox.com" && method === "POST";
  out.set("origin", roblox ? "https://www.roblox.com" : target.origin);
  out.set("referer", roblox ? "https://www.roblox.com/" : `${target.origin}/`);
  if (gameJoin) {
    if (out.has("rbx-user-agent")) out.set("rbx-user-agent", desktopAgent(out.get("rbx-user-agent")));
    body = joinNamedServer(target, body);
  }
  const cookies = cookieHeader(target);
  if (cookies) out.set("cookie", cookies);

  const epoxy = await transport;
  let timer;
  const response = await Promise.race([
    epoxy.request(target, method, body && body.byteLength ? body : null, [...out], undefined),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer from ${target.hostname} through the Wisp server ${WISP} in ${REQUEST_TIMEOUT_MS / 1000}s`)),
        REQUEST_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  let data = await new Response(response.body).arrayBuffer();

  let jar = null;
  const kept = [];
  for (const [name, value] of response.headers) {
    const key = name.toLowerCase();
    if (key === "set-cookie") {
      const cookie = parseSetCookie(target, value);
      if (cookie) jar = putCookie(jar ?? readJar(), cookie);
    } else if (key === "location") {
      kept.push([key, new URL(value, target).href]);
    } else if (!DROP_RESPONSE.has(key)) {
      kept.push([key, value]);
    }
  }
  if (jar) writeJar(jar);
  if (gameJoin) data = withGameFqdn(target, response.status, data);
  if (target.hostname === "clientsettingscdn.roblox.com" && response.status === 200) data = withoutWebGpu(data);
  return { status: response.status, statusText: response.statusText, headers: kept, body: data };
}

navigator.serviceWorker.addEventListener("message", async (event) => {
  const message = event.data;
  if (message?.type !== "blox-fetch") return;
  const [port] = event.ports;
  try {
    const result = await upstream(message);
    port.postMessage({ ok: true, ...result }, [result.body]);
  } catch (error) {
    console.error("[blox] relay failed:", message.method, message.url, error);
    port.postMessage({ ok: false, error: String(error?.message || error) });
  }
});
navigator.serviceWorker.startMessages();

// ---- Session ------------------------------------------------------------------

// Only 401 means the session is no good. Anything else (429: Roblox limits the
// Wisp server's IP) is an error to show, not a reason to ask for a new session.
async function sessionAccepted() {
  const result = await upstream({ url: SESSION_CHECK, method: "GET", headers: [], body: null });
  if (result.status === 200) return true;
  if (result.status === 401) return false;
  throw new Error(`Roblox answered HTTP ${result.status} checking your session. Try again in a minute.`);
}

// src/pages/browser/blox.ts leaves the live session from breeze's browser here
// right before opening this page; IndexedDB below can lag behind it.
const HANDOFF_KEY = "blox.handoff";

async function proxySession() {
  const handed = localStorage.getItem(HANDOFF_KEY);
  localStorage.removeItem(HANDOFF_KEY);
  return handed || (await storedProxySession());
}

// Breeze's browser (the Scramjet controller) keeps its cookie jar in this
// origin's IndexedDB, so signing in to roblox.com there leaves .ROBLOSECURITY
// where this page can read it. Never creates the database when it is missing.
function storedProxySession() {
  return new Promise((resolve) => {
    const open = indexedDB.open("__scramjet_controller");
    open.onupgradeneeded = () => open.transaction.abort();
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      const finish = (value) => {
        db.close();
        resolve(value);
      };
      try {
        const get = db.transaction("state", "readonly").objectStore("state").get("cookies");
        get.onsuccess = () => finish(sessionFromDump(get.result?.cookies));
        get.onerror = () => finish(null);
      } catch {
        finish(null);
      }
    };
  });
}

// The controller stores CookieJar.dump(): JSON of { [key]: { name, value, domain, … } }.
function sessionFromDump(dump) {
  if (typeof dump !== "string") return null;
  let cookies;
  try {
    cookies = JSON.parse(dump);
  } catch {
    return null;
  }
  for (const cookie of Object.values(cookies ?? {})) {
    if (cookie?.name !== SESSION || typeof cookie.value !== "string" || !cookie.value) continue;
    if (/^\.?(?:[^.]+\.)*roblox\.com$/i.test(String(cookie.domain))) return cookie.value;
  }
  return null;
}

// Puts a candidate session in the jar and keeps it only if Roblox accepts it.
async function trySession(value, manual) {
  storeSession(value, manual);
  if (await sessionAccepted()) return true;
  forgetSession();
  return false;
}

// Joining needs a signed-in account (gamejoin answers 524 "Not authorized"
// otherwise), so this runs before the engine starts and only then.
function askForSession(expired) {
  return new Promise((resolve) => {
    const shade = document.createElement("div");
    shade.className = "session";
    shade.innerHTML = `
      <form novalidate aria-labelledby="session-title">
        <h1 id="session-title"></h1>
        <p>Sign in to roblox.com in breeze’s browser, choosing the email one-time code, then press Sign in here.</p>
        <p>Or paste the value of your <code>.ROBLOSECURITY</code> cookie. It stays in this browser and is sent only to Roblox, encrypted end to end.</p>
        <input name="cookie" type="password" autocomplete="off" spellcheck="false" aria-label=".ROBLOSECURITY (optional)" aria-describedby="session-error">
        <p class="error" id="session-error" role="alert"></p>
        <div class="actions">
          <button type="button" class="secondary">Back</button>
          <button type="submit">Sign in</button>
        </div>
      </form>`;
    const form = shade.querySelector("form");
    const input = form.querySelector("input");
    const error = form.querySelector(".error");
    const [back, submit] = form.querySelectorAll("button");
    form.querySelector("h1").textContent = expired ? "Your Roblox session expired" : "Sign in to Roblox";
    const fail = (text) => {
      error.textContent = text;
      input.setAttribute("aria-invalid", "true");
      input.focus();
    };
    input.addEventListener("input", () => {
      error.textContent = "";
      input.removeAttribute("aria-invalid");
    });
    back.addEventListener("click", () => location.assign(ROOT.href));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const pasted = input.value.trim().replace(/^\.ROBLOSECURITY=/, "");
      if (pasted && !pasted.startsWith(SESSION_PREFIX)) return fail("That isn't a .ROBLOSECURITY value.");
      const value = pasted || (await proxySession());
      if (!value) return fail("No Roblox sign-in found in breeze’s browser yet.");
      submit.disabled = true;
      let accepted = false;
      try {
        accepted = await trySession(value, Boolean(pasted));
      } catch (err) {
        forgetSession();
        submit.disabled = false;
        return fail(`Couldn't reach Roblox: ${err.message || err}`);
      }
      submit.disabled = false;
      if (!accepted) return fail(pasted ? "Roblox rejected that session." : "The sign-in in breeze’s browser has expired. Sign in there again.");
      shade.remove();
      resolve();
    });
    document.body.append(shade);
    input.focus();
  });
}

// Signing in on roblox.com in breeze's browser is the usual way in, so that
// session wins (an account switched there follows here), unless one was
// pasted here on purpose. The other is the fallback.
async function ensureSession() {
  const saved = savedSession();
  const manual = localStorage.getItem(MANUAL_KEY) === "1";
  const proxied = await proxySession();
  const order = manual ? [saved, proxied] : [proxied, saved];
  for (const value of new Set(order.filter(Boolean))) {
    if (await trySession(value, value === saved && manual)) return;
  }
  return askForSession(saved !== null);
}

// ---- Launcher -----------------------------------------------------------------

const GAME_LINK = /roblox\.com\/(?:[a-z]{2}\/)?games\/([1-9]\d{0,18})/i;

function placeFromInput(text) {
  const value = text.trim();
  if (/^[1-9]\d{0,18}$/.test(value)) return value;
  return GAME_LINK.exec(value)?.[1] ?? null;
}

async function robloxJson(url) {
  const result = await upstream({ url, method: "GET", headers: [["accept", "application/json"]], body: null });
  // Roblox limits requests per IP, and the IP it sees is the Wisp server's.
  if (result.status === 429) throw new Error(`Roblox is rate-limiting the Wisp server (${WISP}). Try again in a minute, or set your own Wisp server in breeze's settings.`);
  if (result.status !== 200) throw new Error(`Roblox answered HTTP ${result.status}`);
  return JSON.parse(new TextDecoder().decode(result.body));
}

async function searchGames(query) {
  const search = await robloxJson(
    `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}&sessionId=${crypto.randomUUID()}&pageType=all`,
  );
  const games = (search.searchResults ?? [])
    .filter((group) => group.contentGroupType === "Game")
    .flatMap((group) => group.contents ?? [])
    .filter((game) => game.rootPlaceId && game.universeId)
    .slice(0, 30);
  if (!games.length) return [];
  const icons = await robloxJson(
    `https://thumbnails.roblox.com/v1/games/icons?universeIds=${games.map((game) => game.universeId).join(",")}&size=150x150&format=Webp&isCircular=false`,
  ).catch(() => ({ data: [] }));
  const iconOf = new Map((icons.data ?? []).map((icon) => [icon.targetId, icon.imageUrl]));
  return games.map((game) => ({
    placeId: String(game.rootPlaceId),
    name: game.name,
    creator: game.creatorName,
    players: game.playerCount,
    icon: iconOf.get(game.universeId),
  }));
}

function play(placeId) {
  const url = new URL(location.href);
  url.search = `?placeId=${placeId}`;
  location.assign(url);
}

function gameItem(game) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  const icon = document.createElement("img");
  icon.alt = "";
  icon.loading = "lazy";
  if (game.icon) icon.src = game.icon;
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = game.name;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = [game.creator, Number.isFinite(game.players) ? `${game.players.toLocaleString()} playing` : ""].filter(Boolean).join(" · ");
  button.append(icon, name, meta);
  button.addEventListener("click", () => play(game.placeId));
  item.append(button);
  return item;
}

function showLauncher() {
  document.getElementById("loading-overlay").hidden = true;
  const launcher = document.createElement("main");
  launcher.className = "launcher";
  launcher.innerHTML = `
    <form role="search">
      <input type="search" placeholder="Search games or paste a game link" aria-label="Search games or paste a game link" autocomplete="off" spellcheck="false">
      <button type="submit">Search</button>
    </form>
    <p class="launcher-status" role="status"></p>
    <ul class="launcher-games"></ul>`;
  const form = launcher.querySelector("form");
  const input = launcher.querySelector("input");
  const status = launcher.querySelector(".launcher-status");
  const list = launcher.querySelector(".launcher-games");
  let search = 0;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const place = placeFromInput(input.value);
    if (place) return play(place);
    const query = input.value.trim();
    if (!query) return;
    const current = ++search;
    status.textContent = "Searching…";
    list.replaceChildren();
    try {
      const games = await searchGames(query);
      if (current !== search) return;
      status.textContent = games.length ? "" : "No games found.";
      list.replaceChildren(...games.map(gameItem));
    } catch (error) {
      if (current === search) status.textContent = `Search failed: ${error.message || error}`;
    }
  });
  document.body.append(launcher);
  input.focus();
}

// ---- Boot ---------------------------------------------------------------------

async function controlled() {
  if (!("serviceWorker" in navigator)) throw new Error("This browser has no service worker support.");
  // On the CDN build the page is already controlled by sw.js?standalone, which
  // index.svg registered and which serves this page: register that again, so
  // it is checked for updates, rather than replace it with the server's kind.
  const script = navigator.serviceWorker.controller?.scriptURL ?? new URL("sw.js", ROOT).href;
  await navigator.serviceWorker.register(script, { scope: ROOT.pathname });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  // First visit: the worker claims this page once it activates.
  await new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  if (!navigator.serviceWorker.controller) throw new Error("The service worker did not take control of this page. Reload to try again.");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.append(script);
  });
}

// ---- Mouse lock ---------------------------------------------------------------

// The engine locks the mouse (right-drag camera, shift lock, first person)
// through emscripten, which calls canvas.requestPointerLock() once and then
// assumes it worked. Chrome refuses a request without a recent click, from a
// window that is not focused, or within about a second of Escape releasing
// the lock, and the engine never asks again. Remember that it wants the lock
// until it lets go, and ask again on the next click on the game.
function keepPointerLock(canvas) {
  const request = Element.prototype.requestPointerLock;
  const exit = Document.prototype.exitPointerLock;
  let wanted = false;
  const lock = () => {
    if (!wanted || document.pointerLockElement === canvas) return;
    try {
      // Chrome returns a promise that rejects when refused; the next gesture retries.
      request.call(canvas)?.catch?.(() => {});
    } catch {}
  };
  canvas.requestPointerLock = () => {
    wanted = true;
    lock();
  };
  document.exitPointerLock = () => {
    wanted = false;
    exit.call(document);
  };
  // Capture phase: runs before the engine's own handler, inside the click
  // that makes Chrome accept the request.
  canvas.addEventListener("mousedown", lock, true);
}

async function boot() {
  if (!window.crossOriginIsolated) {
    throw new Error("This page is not cross-origin isolated, so the engine cannot use shared memory.");
  }
  say("Connecting…");
  await controlled();
  await transport;
  const placeId = new URLSearchParams(location.search).get("placeId");
  // The engine only joins experiences: without a place it logs "no startup
  // place id" and exits, so pick one here first.
  if (!placeId || !/^[1-9]\d{0,18}$/.test(placeId)) return showLauncher();
  say("Checking your Roblox session…");
  await ensureSession();
  say("Starting…");
  // What Roblox's WasmLoader.js leaves behind for WasmPlayer.js. channel null
  // keeps the engine on the production flags and channel.
  window.__wasmLoaderContext = { engineBase: ENGINE_BASE, channel: null, server: "prod" };
  const canvas = document.getElementById("canvas");
  keepPointerLock(canvas);
  // Right-drag turns the camera; the browser's menu would swallow the drag.
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  await loadScript(`${ENGINE_BASE}/WasmPlayer.js`);
}

boot().catch((error) => {
  console.error("[blox]", error);
  say(error.message || String(error));
});
