// Opens the workbench registry over a layout of content cards in one row, for the party tests (docs/spec/parties.md).
// The cards are the grid cells of one row, one column each, so two cards whose columns are adjacent touch. The page modules
// are the real ones: the environment is installed from the same document shape that the projects-format-1 test uses, and the
// core entries are installed with the page memory saver. The party commands and the party status are declared by the core
// exposure file and registered by the party module of the page; a test that calls them before that module exists fails.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pageMemorySaver } from "./memory-saver.mjs";

const probeManifest = {
  id: "probe-plain", name: "Plain", description: "검사용.", mark: "P", icon: "<path d='M0 0h1v1H0z'/>",
  surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
};

/**
 * Opens a window whose one row holds the cards in the given order, each card one column.
 * The order of the array is the order in which the space stores its cards (docs/spec/parties.md#queries).
 */
export async function openPartyWindow(cardIds) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.devicePixelRatio = 2;
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;

  const xs = cardIds.map((_, index) => index).concat(cardIds.length);
  const environmentDocument = {
    runtime: "runtime",
    workspace: { focus: cardIds[0], grid: { xs, ys: [0, 1], cards: cardIds.map((id, index) => ({
      id, c0: index, c1: index + 1, r0: 0, r1: 1, tabs: [{ plugin: "probe-plain", title: id }],
    })) } },
    sidebars: { sets: [], links: [] },
  };
  const { installEnvironment } = await import("../../environment.js");
  installEnvironment(environmentDocument, { plugins: [
    { id: "probe-plain", package: "@fixture/probe-plain", version: "0.0.1", manifest: probeManifest },
  ] });

  const { registry } = await import("../../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../../core-exposure.js");
  await installCoreExposure({
    memorySaver: await pageMemorySaver(),
    library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  });
  // The party module of the page registers the party commands and the party status when it is imported.
  await import("../../parties.js");
  return {
    registry,
    run: (name, params = {}) => registry.run(name, params),
    get: (name, params = {}) => registry.handle({ method: "status.get", params: { name, ...params } }),
    close: () => dom.window.close(),
  };
}
