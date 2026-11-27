// A core status whose read answers later, as core.tab.role reads the workspace store of the host (docs/spec/agent-roles.md#tab-role-state):
// an observation receives the value that each read resolves, at its start and at each change of the core state, against the page-wire
// case core-status-resolved-read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const OWNER = "tab-aaaaa1";
// The page-wire case answers every call of the page in order; it is selected before the modules that read the host are imported.
const wire = selectPageWire("core-status-resolved-read");

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

const PLUGIN = "fixture";
const manifest = {
  id: PLUGIN, name: PLUGIN, description: "검사용 표면.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
};
const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: PLUGIN, title: "t" }] } } },
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
await installCoreExposure({ home: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
plane.nameWindow("main");
projects.begin({ common: {}, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main", lastCard: 1, state: {
    root: { card: "main", data: { tabs: [{ id: OWNER, plugin: PLUGIN, title: PLUGIN, origin: { directory: null }, role: null }], activeId: OWNER } } } } },
], activeSpaceId: "spc-aaaaaa", named: 2 }] });

await projects.initialise(new HostWorkspaceStore(host), () => false);

test("an observation of core.tab.role receives the role that each read resolves, not the promise of the read", { timeout: 5000 }, async () => {
  const values = [];
  const stop = registry.observe("core.tab.role", OWNER, (value) => values.push(value));
  const settled = async () => {
    for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settled();
  coreChanged();
  await settled();
  stop();
  assert.deepEqual(values, [
    { role: null, generation: null, state: null, seq: 0, fingerprint: null, path: null },
    { role: "a", generation: 1, state: "pending", seq: 1, fingerprint: "0123456789abcdef", path: "/config/agents/tab-aaaaa1/role.md" },
  ]);
  wire.finish();
});
