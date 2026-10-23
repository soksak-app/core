// The interface that plugin pages and modal pages use.
//
// A surface and a modal are separate documents, so they do not inherit the stylesheet of the main page. They set the theme
// tokens that the host sent on their own root.
import { page as runtimePage } from "@soksak/runtime";
import {
  createExpose, declarationMap, orderedSidecar, pageIdentity,
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
      const root = document.documentElement;
      root.style.colorScheme = theme.scheme;
      for (const [token, value] of Object.entries(theme.tokens)) {
        root.style.setProperty(token, value);
      }
      applied();
    });
  });
}

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

/** The plugin declarations of this host or modal document; core document entries belong to the view bridge. */
async function ownDeclarations() {
  // default: exposes is optional; a plugin without it registers no entries.
  return declarationMap((await ownManifest()).exposes ?? {});
}

/** The exposure registration function of a surface page. It is null without a native host. */
export const expose = page?.exposure ? createExpose(page.exposure, ownDeclarations) : null;

/** Attaches all declared native anchors at once and places them together in one measurement. */
export async function createSurfaceComposition({ regions = {}, overlays = {} } = {}) {
  if (!runtimePage) return null;
  const declaration = (await ownManifest()).surface?.composition;
  return createSurfaceCompositionController(runtimePage, declaration, { regions, overlays }, window);
}
