// Starts the Scramjet 1.1.0 engine for the "Scramjet 1.1.0" switch under
// Settings > Proxy (the app side is src/pages/browser/legacy.ts).
//
// It lives beside the vendored files rather than in the app bundle because the
// production build scrubs every vendor name out of the bundle, and this file
// has to call the 1.x globals by name. postbuild.mjs ships this folder as-is.
// Every path resolves against this module's own url, so it works at the
// server root, in the about:blank/blob launcher and at a deep CDN folder.
import { BareMuxConnection } from "./bm.mjs";

const here = new URL("./", import.meta.url);
const at = (name) => new URL(name, here);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(script);
  });
}

// Registers sw.js scoped to this folder and waits for it to be active. The
// page itself stays under the 2.x worker, so navigator.serviceWorker.ready
// (which tracks the page's own scope) cannot be used here.
async function activeWorker() {
  const registration = await navigator.serviceWorker.register(at("sw.js").href, { scope: here.href });
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) throw new Error("the legacy service worker did not install");
  if (worker.state !== "activated") {
    await new Promise((resolve, reject) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
        else if (worker.state === "redundant") reject(new Error("the legacy service worker failed to install"));
      });
    });
  }
  return registration.active ?? worker;
}

function reloadWorkerConfig(worker) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    worker.postMessage({ breeze$reloadConfig: true }, [channel.port2]);
    // An older worker without the handler never answers; go on regardless.
    setTimeout(resolve, 2000);
  });
}

let started = null;

// Resolves with a 1.x ScramjetController that is ready to create frames.
export function start({ wisp }) {
  started ??= (async () => {
    if (!navigator.serviceWorker) throw new Error("this browser has no service worker support");
    if (typeof SharedWorker === "undefined") throw new Error("this browser has no SharedWorker support");
    if (typeof globalThis.$scramjetLoadController !== "function") await loadScript(at("sj.all.js").href);

    const { ScramjetController } = globalThis.$scramjetLoadController();
    // The worker matches these against location.origin + path, so they are
    // root-relative pathnames, not full urls.
    const controller = new ScramjetController({
      prefix: at("p/").pathname,
      files: {
        all: at("sj.all.js").pathname,
        sync: at("sj.sync.js").pathname,
        wasm: at("sj.wasm.wasm").pathname,
      },
    });
    // init() before the worker exists. It creates the "$scramjet" database
    // with its stores; the 1.x worker opens that database at the same version
    // with no upgrade step as soon as it starts, so a worker that got there
    // first would leave it empty and the config could never be saved.
    await controller.init();

    const worker = await activeWorker();
    await reloadWorkerConfig(worker);

    // bare-mux wants an absolute worker url; the transport is imported inside
    // that SharedWorker, so its url must be absolute too.
    const connection = new BareMuxConnection(at("bm.worker.js").href);
    await connection.setTransport(at("epoxy.mjs").href, [{ wisp }]);
    return controller;
  })();
  started.catch(() => {
    started = null;
  });
  return started;
}
