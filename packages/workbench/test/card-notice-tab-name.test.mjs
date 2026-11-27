// The card line of a notice names the tab of the notice when the tab is not the active tab of its card, and core.grid reports the
// notice of the card (docs/spec/notifications.md#card-status-line), against the page-wire case card-notice-tab-name with two tabs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const ACTIVE = "tab-aaaaa1";
const OTHER = "tab-aaaaa2";
const PLUGIN = "fixture";
// The page-wire case answers every call of the page in order; it is selected before the modules that read the host are imported.
const wire = selectPageWire("card-notice-tab-name");

const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), CSS: dom.window.CSS, PointerEvent: dom.window.PointerEvent,
  MouseEvent: dom.window.MouseEvent, ErrorEvent: dom.window.ErrorEvent,
  addEventListener: dom.window.addEventListener.bind(dom.window), dispatchEvent: dom.window.dispatchEvent.bind(dom.window),
  devicePixelRatio: dom.window.devicePixelRatio })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
Object.defineProperty(document.getElementById("plane"), "clientWidth", { value: 1600 });
Object.defineProperty(document.getElementById("plane"), "clientHeight", { value: 1200 });
Object.defineProperty(document, "adoptedStyleSheets", { value: [] });
// The card border and divider sizes come from the page style, as in the layout tests.
const style = document.createElement("style");
style.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.append(style);

const manifest = {
  id: PLUGIN, name: PLUGIN, description: "검사용 표면.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
};
const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: PLUGIN, title: "t" }, { plugin: PLUGIN, title: "second" }] } } },
  sidebars: { sets: [], links: [] },
}, { plugins: [{ id: PLUGIN, package: "@fixture/plain", version: "0.0.1", folder: "/installed/plugin", manifest }] }), [], "the fixture environment was refused");
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const projects = await import("../projects.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { host } = await import("@soksak/runtime");
const plane = await import("../plane.js");
const { coreChanged, installCoreExposure } = await import("../core-exposure.js");
const { pageMemorySaver } = await import("./support/memory-saver.mjs");
const { notificationStore, reportTitle } = await import("../tab-reports.js");
const { flushEvents } = await import("../page-log.js");
await installCoreExposure({ home: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
plane.nameWindow("main");
projects.begin({ common: {}, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main", lastCard: 1, state: {
    root: { card: "main", data: { tabs: [
      { id: ACTIVE, plugin: PLUGIN, title: PLUGIN, origin: { directory: null }, role: null },
      { id: OTHER, plugin: PLUGIN, title: "second", origin: { directory: null }, role: null },
    ], activeId: ACTIVE } } } } },
], activeSpaceId: "spc-aaaaaa", named: 2 }] });

await projects.initialise(new HostWorkspaceStore(host), () => false);
// The plane draws a space only when it adopts the layout, as the layout tests do; the tabs are those of the case.
plane.adopt({ focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main", lastCard: 1, state: { root: { card: "main", data: {
  tabs: [
    { id: ACTIVE, plugin: PLUGIN, title: PLUGIN, origin: { directory: null }, role: null },
    { id: OTHER, plugin: PLUGIN, title: "second", origin: { directory: null }, role: null },
  ],
  activeId: ACTIVE,
} } } }, "spc-aaaaaa");

const settle = async () => {
  for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const status = async (name) => (await registry.handle({ id: 1, method: "status.get", params: { name } })).result;

test("a notice of the tab that is not active names the tab on the card line and core.grid reports the notice of the card", { timeout: 5000 }, async () => {
  // The surface of the second tab reports its title, which names the tab on the card line (lineTabName in plane.js).
  reportTitle(OTHER, "second");
  notificationStore().showTab({ kind: "info", title: "second tab done", text: "" }, { card: "main", tab: OTHER, plugin: PLUGIN });
  await settle();
  coreChanged();
  await settle();
  const line = document.querySelector("#plane .notice-line");
  assert.notEqual(line, null, "the card line of the notice is drawn");
  assert.equal(line.querySelector(".notice-line__tab")?.textContent, "second", "the card line names the tab of the notice");
  assert.equal(line.querySelector(".notice-line__title")?.textContent, "second tab done");
  const card = (await status("core.grid")).cards.find((c) => c.id === "main");
  assert.equal(card.notice?.title, "second tab done", "core.grid reports the notice of the card");
  assert.equal(card.notice.kind, "info");
  assert.equal(card.status, null, "a card with a notice reports no status text");
  await flushEvents();
  wire.finish();
});
