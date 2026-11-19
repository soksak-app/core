// The drawing of the group cards of the page workbench (docs/spec/groups.md#drawing): each group card is one container, its frame on the
// drawn rectangle of the group tree filled with the color of its level, its header the top band inside the frame with the name and the
// head buttons of the group, and the cards inside it one gap inside the frame below the header. A fullscreen group card is laid out as
// the whole area (docs/spec/groups.md#card-commands-on-a-group-card). The plane of each test holds the group card card-4 of card-1 and
// card-2 beside card-3 of the root level.
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

const SESSION = "fixture-session";
const EDITOR = "fixture-editor";
const PLAIN = "fixture-plain";
const WINDOW = "main";
const manifest = (id, surface) => ({ id, name: id, description: "검사용 표면.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html" }, ...surface } });

const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: PLAIN, title: "t" }] }] } },
  sidebars: { sets: [], links: [] },
}, { plugins: [
  { id: SESSION, package: "@fixture/session", version: "0.0.1", manifest: manifest(SESSION, {
    params: { type: "object", properties: { name: { type: "string" }, size: { type: "number" }, flags: { type: "object" } } } }) },
  { id: EDITOR, package: "@fixture/editor", version: "0.0.1", manifest: manifest(EDITOR, {
    params: { type: "object", properties: { path: { type: "string" } } }, opens: { extensions: ["html"] } }) },
  { id: PLAIN, package: "@fixture/plain", version: "0.0.1", manifest: manifest(PLAIN, {}) },
] }), [], "the fixture environment refused a plugin");
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { begin } = await import("../projects.js");
const reports = await import("../tab-reports.js");
const plane = await import("../plane.js");
const { coreChanged, installCoreExposure } = await import("../core-exposure.js");
await installCoreExposure({ library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
// The window of the page has the name that its start document carries (docs/spec/native-host.md#page-start).
plane.nameWindow(WINDOW);

const view = (id, plugin) => ({ id, plugin, title: id, origin: { directory: null } });
const content = (id, c0, c1, r0, r1, tabs) => ({ id, c0, c1, r0, r1, data: { tabs, activeId: tabs[0].id } });
begin({ common: {}, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, groups: [], leader: "main",
    lastCard: 1, state: { xs: [0, 1], ys: [0, 1], cards: [content("main", 0, 1, 0, 1, [view("tab-aaaaa1", PLAIN)])] } } },
  { id: "spc-bbbbbb", title: "SPACE2", layout: { focusedId: "card-8", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 10, leader: "card-10",
    groups: [{ card: "card-10", name: "그룹 1", leader: "card-8", members: ["card-8", "card-9"] }],
    state: { xs: [0, 0.5, 1], ys: [0, 1], cards: [content("card-8", 0, 1, 0, 1, [view("tab-ooooo1", PLAIN)]), content("card-9", 1, 2, 0, 1, [view("tab-ooooo2", PLAIN)])] } } },
], activeSpaceId: "spc-aaaaaa", named: 2 }] });

/** Shows three cards in a row, card-1, card-2 and card-3, whose first two are the group card-4 named 그룹 1, with card-1 focused. */
function arrange() {
  plane.closePicker("fixture reset");
  if (plane.currentGrid()) for (const card of plane.currentGrid().cards) for (const tab of plane.tabsOf(card)) reports.forgetTab(tab.id);
  plane.adopt({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 4, leader: "card-4",
    groups: [{ card: "card-4", name: "그룹 1", leader: "card-1", members: ["card-1", "card-2"] }],
    state: { xs: [0, 0.375, 0.75, 1], ys: [0, 1], cards: [content("card-1", 0, 1, 0, 1, [view("tab-aaaaa1", PLAIN)]),
      content("card-2", 1, 2, 0, 1, [view("tab-aaaaa2", PLAIN)]), content("card-3", 2, 3, 0, 1, [view("tab-aaaaa3", PLAIN)])] } }, "spc-aaaaaa");
  plane.settle();
}
const run = (name, params) => registry.run(name, params);
const { groupFill } = await import("../settings.js");

/** The rectangle at which the element of a card or a group card stands, as {x, y, w, h}. */
const placed = (element) => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top), w: parseFloat(element.style.width),
  h: parseFloat(element.style.height) });
const near = (actual, expected, what) => {
  for (const key of ["x", "y", "w", "h"]) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1, `${what} ${key} is ${actual[key]}, not ${expected[key]}`);
  }
};
const cardElement = (id) => planeElement.querySelector(`.card[data-card-id="${id}"]`);
const groupElement = (id) => planeElement.querySelector(`.group[data-group-card="${id}"]`);

test("a group card is one container at its drawn rectangle with the fill of its level and its header inside the frame", { timeout: 5000 }, () => {
  arrange();
  const tree = plane.currentTree();
  const group = groupElement("card-4");
  assert.ok(group, "the group card card-4 is drawn");
  assert.equal(group.dataset.expose, "core.group");
  assert.equal(group.hidden, false);
  near(placed(group), tree.rect("card-4"), "the frame of card-4");
  const probe = document.createElement("i");
  probe.style.background = groupFill(1);
  assert.equal(group.style.background, probe.style.background, "the frame is filled with the color of level 1");
  const header = group.querySelector('[data-expose="core.group.header"]');
  assert.ok(header, "the group card has its header");
  assert.equal(header.querySelector('[data-expose="core.group.name"]').textContent, "그룹 1");
  assert.deepEqual([...header.querySelectorAll("button")].map((button) => button.dataset.expose),
    ["core.group.add", "core.group.split-x", "core.group.split-y", "core.group.wrap", "core.card.leader", "core.group.fullscreen",
      "core.group.close"]);
  assert.deepEqual([...header.querySelectorAll("button")].map((button) => button.dataset.command),
    ["core.card.menu", "core.card.menu", "core.card.menu", "core.card.menu", "core.group.leader", "core.card.fullscreen", "core.group.menu"]);
  // The frames stand below the cards.
  const order = [...planeElement.children];
  assert.ok(order.indexOf(group) < order.indexOf(cardElement("card-1")), "the frame comes before the cards in paint order");
  for (const id of ["card-1", "card-2", "card-3"]) near(placed(cardElement(id)), tree.rect(id), `card ${id}`);
  const head = tree.headRect("card-4");
  assert.ok(placed(cardElement("card-1")).y >= head.y + head.h, "card-1 stands below the header of card-4");
});

test("a group card that the tree no longer holds is removed from the plane", { timeout: 5000 }, async () => {
  arrange();
  assert.ok(groupElement("card-4"), "the group card card-4 is drawn before it is dissolved");
  await run("core.group.dissolve", { group: "card-4" });
  assert.equal(groupElement("card-4"), null);
});

test("a fullscreen group card is laid out as the whole area and a focus inside it keeps it fullscreen", { timeout: 5000 }, async () => {
  arrange();
  await run("core.card.fullscreen", { card: "card-4" });
  const tree = plane.currentTree();
  const grid = plane.currentGrid();
  const shown = tree.fullscreen("card-4", { x: 0, y: 0, w: grid.width, h: grid.height });
  near(placed(groupElement("card-4")), shown.get("card-4"), "the fullscreen frame of card-4");
  for (const id of ["card-1", "card-2"]) near(placed(cardElement(id)), shown.get(id), `card ${id} inside the fullscreen group card`);
  assert.equal(placed(cardElement("card-3")).w, 0, "card-3 outside the fullscreen group card is hidden");
  assert.equal(groupElement("card-4").querySelector('[data-expose="core.group.fullscreen"]').getAttribute("aria-pressed"), "true");
  await run("core.card.focus", { card: "card-2" });
  assert.equal(plane.fullscreenCard(), "card-4", "a focus of a card inside the fullscreen group card keeps it fullscreen");
  await run("core.card.fullscreen", { card: "card-4" });
  assert.equal(plane.fullscreenCard(), null, "a second press restores the arrangement");
});
