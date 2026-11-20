// The rail of a content card inside a group card on the page workbench (docs/spec/external-sidebars.md#override-context-and-rail-border).
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
// core.rail reads railState of the plane (core-exposure.js).
const rail = () => plane.railState();

// A content card inside a group card keeps the rail of its overridden window sidebar: the rail joins the focused card and its sidebar,
// which a group frame and a gap separate, so it draws one outline around the card and one around the sidebar beside the focus ring of
// the card (docs/spec/external-sidebars.md#override-context-and-rail-border, docs/spec/groups.md#drawing).
test("the rail of a card inside a group card outlines the card and its sidebar apart", { timeout: 5000 }, async () => {
  plane.adopt(layout(), "spc-aaaaaa");
  plane.settle();
  const before = rail();
  assert.deepEqual(before.groups.map(({ card, sidebars }) => ({ card, sidebars })), [{ card: "card-1", sidebars: ["right"] }],
    "the browser card does not hold the rail of the right sidebar before the group");
  await run("core.group.create", { card: "card-1", side: "right", plugin: PLAIN });
  await run("core.card.focus", { card: "card-1" });
  plane.settle();
  const after = rail();
  assert.deepEqual(after.groups.map(({ card, sidebars }) => ({ card, sidebars })), [{ card: "card-1", sidebars: ["right"] }],
    "with card-1 inside a group card the rail groups");
  assert.equal((after.path.match(/M/g) ?? []).length, 2, `the rail path draws other than two outlines: ${after.path}`);
});
