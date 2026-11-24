// The plane lays out again when an error toast opens or closes, so the window overlays of the next placement cut each open toast out of
// the container of the surface hosts (F1147, docs/spec/native-surfaces.md#surface-host-container).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { pageMemorySaver } from "./support/memory-saver.mjs";

const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), CSS: dom.window.CSS, PointerEvent: dom.window.PointerEvent,
  MouseEvent: dom.window.MouseEvent, ErrorEvent: dom.window.ErrorEvent,
  addEventListener: dom.window.addEventListener.bind(dom.window), dispatchEvent: dom.window.dispatchEvent.bind(dom.window),
  // The plane aligns itself to the device pixel grid of this scale on every draw (device-grid.js).
  devicePixelRatio: dom.window.devicePixelRatio })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
// JSDOM has no layout engine and does not load the application stylesheet: the plane gets a size with room to split.
const planeElement = document.getElementById("plane");
Object.defineProperty(planeElement, "clientWidth", { value: 1600 });
Object.defineProperty(planeElement, "clientHeight", { value: 1200 });
const style = document.createElement("style");
style.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.appendChild(style);
Object.defineProperty(document, "adoptedStyleSheets", { value: [] });

const PLAIN = "fixture-plain";
const BROWSER = "fixture-browser";
const WINDOW = "main";
const manifest = (id, extra) => ({ id, name: id, description: "검사용 표면.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html" } }, ...extra });

// The browser fixture overrides the right window sidebar with a set of its own section, as a browser plugin shows its tabs there.
const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: PLAIN, title: "t" }] } } },
  sidebars: { sets: [{ id: "set-tabs", title: "Tabs", sections: [`${BROWSER}.tabs`], layout: "list" }],
    links: [{ place: "window-right", plugin: BROWSER, set: "set-tabs" }] },
}, { plugins: [
  { id: PLAIN, package: "@fixture/plain", version: "0.0.1", manifest: manifest(PLAIN, {}) },
  { id: BROWSER, package: "@fixture/browser", version: "0.0.1", manifest: manifest(BROWSER, {
    sections: [{ id: `${BROWSER}.tabs`, name: "Tabs", composition: { kind: "view", page: "ui/tabs.html" }, height: "fill" }] }) },
] }), [], "the fixture environment refused a plugin");
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { begin } = await import("../projects.js");
const plane = await import("../plane.js");
const { installCoreExposure } = await import("../core-exposure.js");
await installCoreExposure({ library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
plane.nameWindow(WINDOW);

const view = (id, plugin) => ({ id, plugin, title: id, origin: { directory: null }, role: null });
const content = (id, tabs) => ({ card: id, data: { tabs, activeId: tabs[0].id } });
// The layout of the space: the browser card card-1 beside the plain card card-2, with card-1 focused.
const layout = () => ({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, leader: "card-1", lastCard: 2,
  state: { root: { cut: "x", kids: [
    { share: 0.5, node: content("card-1", [view("tab-aaaaa1", BROWSER)]) },
    { share: 0.5, node: content("card-2", [view("tab-aaaaa2", PLAIN)]) }] } } });
begin({ common: { right: true }, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: layout() }], activeSpaceId: "spc-aaaaaa", named: 1 }] });
const run = (name, params) => registry.run(name, params);

const { showError, hideError } = await import("../shown-errors.js");

test("an error toast that opens or closes lays out the plane again", { timeout: 5000 }, async () => {
  plane.adopt(layout(), "spc-aaaaaa");
  plane.settle();
  const layouts = [];
  plane.onLayout((made, draw, seated, titlebar, held, grabs) => {
    layouts.push(grabs);
    draw();
  });
  showError(document, "toast-check", "a toast over a surface");
  assert.equal(layouts.length, 1, "the open toast laid out the plane other than once");
  hideError(document, "toast-check");
  assert.equal(layouts.length, 2, "the closed toast laid out the plane other than once");
});
