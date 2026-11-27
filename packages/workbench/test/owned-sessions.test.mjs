// The owned session commands core.session.open, core.session.resize and core.session.end of the main page
// (docs/spec/plugins.md#owned-sessions). The page runs without a host, as in the browser runtime, so the cases
// hold the refusals that the contract states before any sidecar is asked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

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
const planeElement = document.getElementById("plane");
Object.defineProperty(planeElement, "clientWidth", { value: 1600 });
Object.defineProperty(planeElement, "clientHeight", { value: 1200 });
Object.defineProperty(document, "adoptedStyleSheets", { value: [] });

const PLAIN = "fixture-plain";
const WINDOW = "main";
const manifest = (id) => ({ id, name: id, description: "검사용 표면.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html" } } });

const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: PLAIN, title: "t" }] } } },
  sidebars: { sets: [], links: [] },
}, { plugins: [{ id: PLAIN, package: "@fixture/plain", version: "0.0.1", folder: "/installed/plugin", manifest: manifest(PLAIN) }] }), [],
"the fixture environment refused a plugin");
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { begin } = await import("../projects.js");
const plane = await import("../plane.js");
const { installCoreExposure } = await import("../core-exposure.js");
const { pageMemorySaver } = await import("./support/memory-saver.mjs");
await installCoreExposure({ home: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
plane.nameWindow(WINDOW);
begin({ common: {}, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main", lastCard: 1, state: {
    root: { card: "main", data: { tabs: [{ id: "tab-aaaaa1", plugin: PLAIN, title: PLAIN, origin: { directory: null }, role: null }], activeId: "tab-aaaaa1" } } } } },
], activeSpaceId: "spc-aaaaaa", named: 2 }] });

test("core.session.open refuses a plugin that declares no sessions", async () => {
  await assert.rejects(registry.run("core.session.open", { plugin: PLAIN, params: {}, size: { width: 80, height: 24, scale: 2 } }),
    /plugin fixture-plain declares no sessions/);
});

test("core.session.input, submit and read refuse a session that is not open", async () => {
  await assert.rejects(registry.run("core.session.input", { session: "fixture-missing", text: "ls" }), /session fixture-missing is not open/);
  await assert.rejects(registry.run("core.session.submit", { session: "fixture-missing", text: "ls" }), /session fixture-missing is not open/);
  await assert.rejects(registry.run("core.session.read", { session: "fixture-missing" }), /session fixture-missing is not open/);
});

test("core.session.resize and core.session.end refuse a session that is not open", async () => {
  await assert.rejects(registry.run("core.session.resize", { session: "fixture-missing", size: { width: 80, height: 24, scale: 2 } }),
    /session fixture-missing is not open/);
  await assert.rejects(registry.run("core.session.end", { session: "fixture-missing" }),
    /session fixture-missing is not open/);
});
