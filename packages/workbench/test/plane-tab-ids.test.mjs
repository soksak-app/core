// A new tab takes no id that a held surface, a tab of a stored layout or a tab issued earlier by this page already
// uses (docs/spec/projects.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const owner = "fixture-ids";

test("a new tab avoids the ids of held surfaces, stored tabs and tabs issued before it", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;

  t.mock.module("../surface-modules.js", { exports: {
    mountSurface: () => Promise.resolve(), disposeSurface: () => Promise.resolve(), mountedSurface: () => null,
    placePluginPlaceholder: () => {}, surfaceForTab: () => null,
  } });
  t.mock.module("../projects.js", { exports: {
    initialProjectContextReady: () => true,
    initialProjectContextFailed: () => false,
    waitForInitialProjectContext: () => Promise.resolve(),
    storedTabTaken: (id) => id === "tab-bbbbbb",
  } });
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [
        { plugin: owner, title: "first" }, { plugin: owner, title: "second" }] }],
    } } }),
    pluginUnits: () => [{ id: owner, name: "Ids", description: "검사용 표면.", surface: true, sections: [] }],
    refusedPlugins: () => new Set(),
  } });
  registerPlugin({ id: owner, name: "Ids", mark: "i", svg: "<path/>", ink: null, drop: null, surface: () => null });

  const waits = await import("../image-detach-waits.js");
  const plane = await import("../plane.js");
  waits.holdImageDetachSurfaces(["tab-aaaaaa"]);
  // The first tab draws the held id, then the stored id, then tab-cccccc; the second tab draws the held id, then the id
  // that the first tab took, then tab-dddddd.
  const draws = [0, 1, 2, 0, 2, 3];
  t.mock.method(crypto, "getRandomValues", (buf) => buf.fill(draws.shift()));
  const fresh = plane.fresh();
  assert.deepEqual(fresh.state.cards[0].data.tabs.map((tab) => tab.id), ["tab-cccccc", "tab-dddddd"]);
  assert.deepEqual(draws, []);
});
