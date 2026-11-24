// The page workbench of the group tests, without a host, as in the browser runtime: the page modules in JSDOM with three fixture plugins,
// the registry with the core declarations, a project of two spaces, and the helpers that arrange the plane and read its statuses. The
// plane of arrange() holds one group card of two cards beside a card of the root level.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pageMemorySaver } from "./memory-saver.mjs";

const markup = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
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

export const SESSION = "fixture-session";
const EDITOR = "fixture-editor";
export const PLAIN = "fixture-plain";
const WINDOW = "main";
const manifest = (id, surface) => ({ id, name: id, description: "검사용 표면.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html" }, ...surface } });

const { installEnvironment } = await import("../../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: PLAIN, title: "t" }] } } },
  sidebars: { sets: [], links: [] },
}, { plugins: [
  { id: SESSION, package: "@fixture/session", version: "0.0.1", folder: "/installed/plugin", manifest: manifest(SESSION, {
    params: { type: "object", properties: { name: { type: "string" }, size: { type: "number" }, flags: { type: "object" } } } }) },
  { id: EDITOR, package: "@fixture/editor", version: "0.0.1", folder: "/installed/plugin", manifest: manifest(EDITOR, {
    params: { type: "object", properties: { path: { type: "string" } } }, opens: { extensions: ["html"] } }) },
  { id: PLAIN, package: "@fixture/plain", version: "0.0.1", folder: "/installed/plugin", manifest: manifest(PLAIN, {}) },
] }), [], "the fixture environment refused a plugin");
export const { registry } = await import("../../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../../exposure.json", import.meta.url), "utf8")).exposes);
const { begin } = await import("../../projects.js");
export const reports = await import("../../tab-reports.js");
export const plane = await import("../../plane.js");
const { installCoreExposure } = await import("../../core-exposure.js");
await installCoreExposure({ library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
// The window of the page has the name that its start document carries (docs/spec/native-host.md#page-start).
plane.nameWindow(WINDOW);

export const view = (id, plugin) => ({ id, plugin, title: id, origin: { directory: null }, role: null });
export const content = (id, tabs) => ({ card: id, data: { tabs, activeId: tabs[0].id } });
/** A box of the group card id with its name and leader around the cut along x of the kids, each [share, node]. */
export const box = (id, name, leader, kids) => ({ box: id, data: { name, leader }, inner: row(kids) });
/** A cut along x of the kids, each [share, node]. */
export const row = (kids) => ({ cut: "x", kids: kids.map(([share, node]) => ({ share, node })) });
begin({ common: {}, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main",
    lastCard: 1, state: { root: content("main", [view("tab-aaaaa1", PLAIN)]) } } },
  { id: "spc-bbbbbb", title: "SPACE2", layout: { focusedId: "card-8", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 10, leader: "card-10",
    state: { root: box("card-10", "그룹 1", "card-8", [[0.5, content("card-8", [view("tab-ooooo1", PLAIN)])], [0.5, content("card-9", [view("tab-ooooo2", PLAIN)])]]) } } },
], activeSpaceId: "spc-aaaaaa", named: 2 }] });

/** Shows three cards in a row, card-1, card-2 and card-3, whose first two are the group card-4 with the default group name of number 1, with card-1 focused. */
export function arrange() {
  plane.closePicker("fixture reset");
  if (plane.currentGrid()) for (const card of plane.currentGrid().cards) for (const tab of plane.tabsOf(card)) reports.forgetTab(tab.id);
  plane.adopt({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 4, leader: "card-4",
    state: { root: row([
      [0.75, box("card-4", "그룹 1", "card-1", [[0.5, content("card-1", [view("tab-aaaaa1", PLAIN)])], [0.5, content("card-2", [view("tab-aaaaa2", PLAIN)])]])],
      [0.25, content("card-3", [view("tab-aaaaa3", PLAIN)])],
    ]) } }, "spc-aaaaaa");
}
export const run = (name, params) => registry.run(name, params);
export const refuses = (promise, text) => assert.rejects(promise, (error) => error.message === text, `does not fail with ${text}`);
export const status = async (name) => (await registry.handle({ id: 1, method: "status.get", params: { name } })).result;
/** The members of a node of the stored tree in tree order: its cards and the boxes that no box inside it holds. */
const membersOf = (node) => (node.cut ? node.kids.flatMap((kid) => membersOf(kid.node)) : [node.box ?? node.card]);
/** The group cards of the stored tree in tree order, each {card, name, level, leader, members}, read from its boxes. */
const groupsOf = (node, level = 1) => {
  if (node.cut) return node.kids.flatMap((kid) => groupsOf(kid.node, level));
  if (node.box === undefined) return [];
  return [{ card: node.box, name: node.data.name, level, leader: node.data.leader, members: membersOf(node.inner) },
    ...groupsOf(node.inner, level + 1)];
};
/** The groups that the stored tree of core.layout holds, with the leader of the root level and lastCard. */
export const stored = async () => {
  const { state, leader, lastCard } = await status("core.layout");
  return { groups: groupsOf(state.root), leader, lastCard };
};

/** Sends the pointer event type at x, y of the plane to element, which captures the pointer as a press of a person does; jsdom does not. */
export const pointer = (element, type, x, y) => {
  element.setPointerCapture ??= () => {};
  element.hasPointerCapture ??= () => true;
  element.releasePointerCapture ??= () => {};
  element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y }));
};
/** The ids of the kids of the root cut of the stored layout. */
export const rootKids = async () => (await status("core.layout")).state.root.kids.map((kid) => kid.node.box ?? kid.node.card);

/** The tab ids of the content card id in their order. */
export const tabIds = (id) => plane.tabsOf(plane.currentGrid().card(id)).map((t) => t.id);

