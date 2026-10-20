// The interface that plugin pages and modal pages use.
//
// A surface and a modal are separate documents, so they do not inherit the stylesheet of the main page. They set the theme
// tokens that the host sent on their own root.
import { page as runtimePage } from "@soksak/runtime";
import {
  EXPOSURE, MANIFEST, SURFACE_CORE, createExpose, declarationMap, orderedSidecar, pageIdentity,
  validateExposureFile,
} from "@soksak/plugin-api";
import { installDocumentErrors } from "./document-errors.js";
import { createSurfaceCompositionController } from "./surface-composition.js";

/* One port for each sidecar name. All transports to the same sidecar follow one order. */
const sidecars = new Map();

/** The page of the runtime. Sidecar transports are delivered in the order they were called. It is null without a native host. */
const publicRuntimePage = runtimePage ? Object.fromEntries(
  Object.entries(runtimePage).filter(([name]) => name !== "document" && name !== "image"),
) : null;

export const page = runtimePage ? Object.freeze({
  ...publicRuntimePage,
  sidecar(name) {
    if (!sidecars.has(name)) {
      // A transport failure is written to the application log. The document of a surface has no place that reads the console.
      sidecars.set(name, orderedSidecar(runtimePage.sidecar(name), (error) => {
        // default: the thrown value may not be an Error, so without message the value itself is written.
        runtimePage.report({ level: "error", where: `sidecar ${name}`, text: `send failed: ${error?.message ?? error}` })
          // When this record fails, there is no other place to report, so it is written to console. default: when the thrown value is not an Error, the value is written.
          .catch((reportError) => console.error(`report of a failed send failed: ${reportError?.message ?? reportError}`));
      }));
    }
    return sidecars.get(name);
  },
}) : null;

// The errors and unhandled rejections of this document are written to the application log when they occur. The document of a surface has no place that reads the console.
if (page) {
  const surface = new URLSearchParams(location.search).get("id");
  installDocumentErrors({
    target: globalThis,
    report: (text) => page.report({ level: "error", where: surface ? `surface ${surface}` : "document", text })
      // When this record fails, there is no other place to report, so it is written to console.
      .catch((error) => console.error(`report of a document error failed: ${error.message}`)),
  });
}

/**
 * Sets the received theme on the root of this document. It is called again when the value changes.
 *
 * The returned promise is fulfilled after the first theme is set. When exposed entries are registered after that,
 * the registered document is a document with the theme applied.
 */
export function followTheme() {
  return new Promise((applied) => {
    page.theme((theme) => {
      themed = true;
      const root = document.documentElement;
      root.style.colorScheme = theme.scheme;
      for (const [token, value] of Object.entries(theme.tokens)) {
        root.style.setProperty(token, value);
      }
      applied();
    });
  });
}

let themed = false;

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`failed to load ${path}: ${response.status}`);
  return response.json();
}

/** The id and the plugin.json of the plugin of this document. The plugin is found from the location of the document ([pageIdentity]). */
async function ownPlugin() {
  const plugin = await pageIdentity(location, fetchJson);
  if (!plugin) throw new Error(`${location.href} is not a plugin page`);
  return plugin;
}

/** The plugin.json of the plugin of this document. */
export async function ownManifest() {
  return (await ownPlugin()).manifest;
}

/**
 * The exposed entries that this document can register: the plugin.json declarations of the same plugin plus the surface
 * document entries (core.surface.*) of the core declarations.
 */
async function ownDeclarations() {
  // default: exposes is an optional field of plugin.json; a plugin without it registers only the core surface entries.
  const plugin = (await ownManifest()).exposes ?? {};
  const core = validateExposureFile(await fetchJson(`/${EXPOSURE}`)).exposes;
  const surfaceCore = Object.fromEntries(Object.entries(core)
    .map(([key, list]) => [key, list.filter((entry) => entry.name.startsWith(SURFACE_CORE))]));
  return declarationMap(surfaceCore, declarationMap(plugin));
}

/** The exposure registration function of a surface page. It is null without a native host. */
export const expose = page?.exposure ? createExpose(page.exposure, ownDeclarations) : null;

/** Attaches all declared native anchors at once and places them together in one measurement. */
export async function createSurfaceComposition({ regions = {}, overlays = {} } = {}) {
  if (!runtimePage) return null;
  const declaration = (await ownManifest()).surface?.composition;
  return createSurfaceCompositionController(runtimePage, declaration, { regions, overlays }, window);
}

/* The input record of the surface document. It is core.surface.input of docs/spec/exposure.md. */
const INPUT_TYPES = ["pointerdown", "pointerup", "pointermove", "click", "wheel", "keydown"];
const INPUT_KEPT = 32;

/** Creates one status that reports when the value changes. */
function observed(read) {
  const listeners = new Set();
  return {
    read,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    notify: () => {
      const value = read();
      for (const fn of listeners) fn(value);
    },
  };
}

/** Registers the core surface entries in every plugin surface document. */
function exposeSurfaceDocument() {
  const root = document.documentElement;
  const documentState = observed(() => ({
    url: location.href,
    timeOrigin: performance.timeOrigin,
    readyState: document.readyState,
    themed,
    scale: devicePixelRatio,
    body: document.body
      ? { width: document.body.getBoundingClientRect().width, height: document.body.getBoundingClientRect().height }
      : null,
    viewport: { width: visualViewport.width, height: visualViewport.height },
    filter: getComputedStyle(root).filter,
    unbound: document.body ? expose.audit(document.body) : [],
  }));
  const events = [];
  let sequence = 0;
  const input = observed(() => events.slice());
  for (const type of INPUT_TYPES) {
    addEventListener(type, (event) => {
      // default: a key event has no coordinates and a pointer event has no key, so those fields are null.
      events.push({ sequence: ++sequence, type, trusted: event.isTrusted, x: event.clientX ?? null, y: event.clientY ?? null, key: event.key ?? null });
      if (events.length > INPUT_KEPT) events.shift();
      input.notify();
    }, true);
  }
  document.addEventListener("readystatechange", documentState.notify);
  addEventListener("resize", documentState.notify);
  visualViewport.addEventListener("resize", documentState.notify);
  new MutationObserver(documentState.notify).observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  // unbound changes when an operable element is added or when its name and command change.
  new MutationObserver(documentState.notify).observe(root, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["data-command", "data-expose", "role", "contenteditable"],
  });
  expose.onBinding(documentState.notify);
  Promise.all([
    expose.status("core.surface.document", documentState.read, documentState.subscribe),
    expose.status("core.surface.input", input.read, input.subscribe),
    expose.command("core.surface.hit", ({ x, y }) => document.elementFromPoint(x, y) !== null),
  ]).catch((error) => console.error(`core surface entries: ${error.message}`));
}

// The surface entries are registered only in a plugin page, and the page identity must resolve first: a mismatch is logged, not registered.
if (expose) {
  pageIdentity(location, fetchJson)
    .then((plugin) => {
      if (plugin) exposeSurfaceDocument();
    })
    .catch((error) => console.error(`core surface entries: ${error.message}`));
}
