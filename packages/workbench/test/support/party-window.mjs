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

// The window sidebars are the cards named by the four sides: a card with the name of a side is a window sidebar and holds no tab.
const WINDOW_SIDES = ["left", "right", "top", "bottom"];

export const CARDS = "abcdefghijklmnop".split("");

const probeManifest = {
  id: "probe-plain", name: "Plain", description: "검사용.", mark: "P", icon: "<path d='M0 0h1v1H0z'/>",
  surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
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
  const dom = new JSDOM(markup, { url: "http://localhost/" });
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
  const environmentDocument = {
    runtime: "runtime",
    workspace: { focus: cardIds[0], grid: { xs, ys: [0, 1], cards: cardIds.map((id, index) => ({
      id, c0: index, c1: index + 1, r0: 0, r1: 1, tabs: WINDOW_SIDES.includes(id) ? [] : [{ plugin: "probe-plain", title: id }],
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
    close: () => dom.window.close(),
  };
}
