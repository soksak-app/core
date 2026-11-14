// core.space.close asks for each modified tab of the window before it removes the active space
// (docs/spec/plugins.md#tab-reports).
// The host calls of the page are answered by the page-wire case space-close-asks-session (docs/spec/cases/page-wire/README.md). The case is
// selected before the modules are imported, because the page reads the host when it imports them. The plane and the project list are the
// real modules of the page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

const pluginId = "fixture-space-close";
const wire = selectPageWire("space-close-asks-session");

const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true,
  addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.history = dom.window.history;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS;
globalThis.PointerEvent = dom.window.PointerEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.ErrorEvent = dom.window.ErrorEvent;
globalThis.devicePixelRatio = dom.window.devicePixelRatio;
// The size of the plane and the border width that app.css gives a card; JSDOM computes no layout and loads no stylesheet.
// JSDOM has no adoptedStyleSheets, which the page reads when it shows a modal; no sheet is adopted here.
Object.defineProperty(document, "adoptedStyleSheets", { value: [] });
const planeEl = document.getElementById("plane");
Object.defineProperty(planeEl, "clientWidth", { value: 800 });
Object.defineProperty(planeEl, "clientHeight", { value: 600 });
const style = document.createElement("style");
style.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.appendChild(style);
// The failures reported through the window error event.
const reported = [];
dom.window.addEventListener("error", (event) => reported.push(event.message));

// The environment of the page: one card with one tab of the plugin.
const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
    { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "document" }] },
  ] } },
  sidebars: { sets: [], links: [] },
}, { plugins: [{ id: pluginId, package: "@fixture/space-close", version: "0.0.1", manifest: {
  id: pluginId, name: "Fixture", description: "Fixture surface.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html" } },
} }] }), [], "the fixture environment refused a plugin");
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const plane = await import("../plane.js");
const projects = await import("../projects.js");
const reports = await import("../tab-reports.js");
const { checkStoredLayout } = await import("../stored-layout.js");
const { orderedCallsAnswered } = await import("../host.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { connectSettings } = await import("../settings.js");
const { flushEvents } = await import("../page-log.js");
const { installCoreExposure } = await import("../core-exposure.js");

// The stored layouts of the two spaces: the plane of the environment with the tab ids that the bytes of the draw give.
const layoutOf = (byte) => {
  const kept = plane.fresh((buffer) => buffer.fill(byte));
  return { state: kept.state, focusedId: kept.focusedId, windowSidebars: kept.windowSidebars, named: kept.named, sidebars: kept.sidebars };
};
const PROJECT = {
  id: "prj-one", root: "/work/one", identity: "1:1", title: "one", color: "#fff", named: 2, activeSpaceId: "spc-aaaaaa",
  spaces: [
    { id: "spc-aaaaaa", title: "SPACE1", layout: layoutOf(1) },
    { id: "spc-bbbbbb", title: "SPACE2", layout: layoutOf(2) },
    { id: "spc-cccccc", title: "SPACE3", layout: layoutOf(3) },
  ],
  settings: {},
};
const COMMON = { "diagnostics.log": { lifecycle: "info", call: "info" } };

projects.onSwitch({
  check: checkStoredLayout, save: plane.capture, load: plane.adopt, update: plane.settle,
  retain: async () => {}, presented: async () => {},
  settleTabs: plane.settleModifiedTabsToClose,
  empty: async (show) => { plane.clear(); show?.(); },
});
projects.begin(structuredClone({ common: COMMON, projects: [PROJECT], open: [] }));
await orderedCallsAnswered();
const store = new HostWorkspaceStore(host);
await connectSettings(store);
await projects.initialise(store);

test("core.space.close asks about modified tabs before it removes the active space", { timeout: 5000 }, async () => {
  try {
    await projects.activate(PROJECT.id);
    await installCoreExposure({
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null,
      drawn: async () => {},
    });
    const tabId = plane.currentGrid().card("main").data.tabs[0].id;
    const spaceIds = () => projects.active().spaces.map(({ id }) => id);
    reports.reportModified(tabId, true);
    // The person keeps the tab: the question stands open and the space stays.
    const kept = registry.run("core.space.close", { id: "spc-aaaaaa" });
    await drained();
    assert.equal(plane.pickerState().open, true, "the active space was removed without the question");
    assert.deepEqual(spaceIds(), ["spc-aaaaaa", "spc-bbbbbb", "spc-cccccc"]);
    plane.pickItem(1);
    assert.deepEqual(await kept, { closed: false });
    assert.deepEqual(spaceIds(), ["spc-aaaaaa", "spc-bbbbbb", "spc-cccccc"]);
    // Another space has no modified tab in the plane, so it closes without a question.
    assert.deepEqual(await registry.run("core.space.close", { id: "spc-bbbbbb" }), { closed: true });
    assert.equal(plane.pickerState().open, false);
    assert.deepEqual(spaceIds(), ["spc-aaaaaa", "spc-cccccc"]);
    // The person discards the changes: the active space is removed after the answer.
    const discarded = registry.run("core.space.close", { id: "spc-aaaaaa" });
    await drained();
    assert.equal(plane.pickerState().open, true, "the active space was removed without the question");
    assert.deepEqual(spaceIds(), ["spc-aaaaaa", "spc-cccccc"]);
    plane.pickItem(0);
    assert.deepEqual(await discarded, { closed: true });
    assert.deepEqual(spaceIds(), ["spc-cccccc"]);
    assert.deepEqual(reported, []);
    await drained();
    await flushEvents();
    wire.finish();
  } finally {
    dom.window.close();
  }
});
