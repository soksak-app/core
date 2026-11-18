// The page window of the party tests (docs/spec/parties.md). A node test file runs in one process, the environment can be installed
// once per process (environment.js refuses a second install), and the page start is shared by the tests of the file, as the page
// tests of this directory share it. The window is one row of the cards a to p, one card per column, so the cards of adjacent
// columns touch. openPartyWindow starts the page once. Each test calls reset first, which deletes every party that the test before
// it left, so each test starts from a layout with no party and the cards in their columns. The page document is the markup of
// index.html, as the page test workbench-statuses uses it, because the modules of the page look up its elements when imported.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
// The party module of the page. It does not exist before the party implementation (F908-4), so every party test fails here first.
import "../../parties.js";
import { pageMemorySaver } from "./memory-saver.mjs";

// The window sidebars are the cards named by the four sides: a card with the name of a side is a window sidebar and declares no tabs
// (docs/spec/external-sidebars.md).
const WINDOW_SIDES = ["left", "right", "top", "bottom"];

// The plane size of the test window, in CSS pixels.
const PLANE_WIDTH = 1000;
const PLANE_HEIGHT = 600;

export const CARDS = "abcdefghijklmnop".split("");

const probeManifest = {
  id: "probe-plain", name: "Plain", description: "검사용.", mark: "P", icon: "<path d='M0 0h1v1H0z'/>",
  surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
  // The status of the tab surface of the terminal work test, declared as the plugin exposes it (docs/spec/exposure.md).
  exposes: { status: [{ name: "probe-plain.busy", description: "Busy.", schema: { type: "boolean" } }] },
  // The section of the window sidebars: a set of a window sidebar holds sections of an installed plugin (docs/spec/external-sidebars.md).
  sections: [{ id: "probe-plain.side", name: "Side", composition: { kind: "view", page: "ui/page.html" }, height: 120 }],
};

let started = null;

/**
 * Starts the page once per process and returns the window: registry, run, get, reset. cardIds is the row of the first start in the
 * process, so a test file that needs another order of the cards starts its own process with that row.
 */
export function openPartyWindow(cardIds = CARDS) {
  started ??= start(cardIds);
  return started;
}

async function start(cardIds) {
  const markup = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  // pretendToBeVisual gives the document the animation frame that the page draws with.
  const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.devicePixelRatio = 2;
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;

  const xs = cardIds.map((_, index) => index).concat(cardIds.length);
  const windowSides = cardIds.filter((id) => WINDOW_SIDES.includes(id));
  const environmentDocument = {
    runtime: "runtime",
    workspace: { focus: cardIds.find((id) => !WINDOW_SIDES.includes(id)), grid: { xs, ys: [0, 1], cards: cardIds.map((id, index) => ({
      id, c0: index, c1: index + 1, r0: 0, r1: 1,
      ...(WINDOW_SIDES.includes(id) ? { fixed: true, width: 190 } : { tabs: [{ plugin: "probe-plain", title: id }] }),
    })) } },
    // A window sidebar is a card of the plane while its side has a link to a set (docs/spec/external-sidebars.md).
    sidebars: {
      sets: windowSides.length ? [{ id: "set-side", title: "Side", sections: ["probe-plain.side"], layout: "list" }] : [],
      links: windowSides.map((side) => ({ place: side, plugin: null, set: "set-side" })),
    },
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
  // The grid of the window exists once a space is shown; the page shows a new space from the environment (docs/spec/parties.md#commands).
  // The page sets the chrome metrics of workbench.json and the theme shape tokens on its root before it draws (chrome-metrics.js, settings.js install).
  const { installChromeMetrics } = await import("../../chrome-metrics.js");
  installChromeMetrics(document.documentElement);
  (await import("../../settings.js")).install();
  // JSDOM has no layout, so the plane element reports the size of a window with the page's measured properties. The page measures the
  // plane with clientWidth and clientHeight and resizes the grid to them (plane.js measureAt).
  const planeElement = document.getElementById("plane");
  Object.defineProperty(planeElement, "clientWidth", { value: PLANE_WIDTH });
  Object.defineProperty(planeElement, "clientHeight", { value: PLANE_HEIGHT });
  const plane = await import("../../plane.js");
  plane.adopt(plane.fresh(), "spc-1");

  const get = async (name, params = {}) => {
    const reply = await registry.handle({ method: "status.get", params: { name, ...params } });
    if (reply.error) throw new Error(reply.error.message);
    return reply;
  };
  return {
    registry,
    run: (name, params = {}) => registry.run(name, params),
    get,
    /** Deletes every party that the previous test left, so the next test starts with no party. */
    async reset() {
      const { result } = await get("core.parties");
      for (const party of result) await registry.run("core.party.delete", { party: party.id });
    },
    // A test calls close in its finally block. The page is shared by the tests of the process, so close keeps the document: closing the
    // JSDOM window removes the plane element, and a later test would read a plane that the document no longer holds. The process ends
    // with the page.
    close: () => {},
  };
}
