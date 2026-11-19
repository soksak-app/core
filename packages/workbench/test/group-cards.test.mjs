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

const headTools = (id) => [...cardElement(id).querySelectorAll(".chrome__acts > .chrome__act:not(.chrome__side)")];
const pick = async (plugin) => {
  const { items } = plane.pickerState();
  const index = items.findIndex((item) => item.key === plugin);
  assert.ok(index >= 0, `the open menu lists ${plugin}`);
  await run("core.picker.pick", { index });
};

test("a content card head shows the group button while the group fits and the leader button pressed on its leader", { timeout: 5000 }, () => {
  arrange();
  assert.deepEqual(headTools("card-1").map((button) => button.dataset.expose),
    ["core.card.add", "core.card.split-x", "core.card.split-y", "core.card.group", "core.card.leader", "core.card.fullscreen", "core.card.close"]);
  const button = (id, name) => cardElement(id).querySelector(`[data-expose="${name}"]`);
  assert.equal(button("card-1", "core.card.group").hidden, false);
  assert.equal(button("card-1", "core.card.group").dataset.command, "core.card.menu");
  assert.deepEqual(JSON.parse(button("card-1", "core.card.group").dataset.params), { card: "card-1", menu: "group" });
  assert.equal(button("card-1", "core.card.leader").dataset.command, "core.group.leader");
  assert.deepEqual(["card-1", "card-2", "card-3"].map((id) => [button(id, "core.card.leader").hidden, button(id, "core.card.leader").getAttribute("aria-pressed")]),
    [[false, "true"], [false, "false"], [false, "false"]], "card-1 leads its level, card-2 does not, and card-4 leads the root level of card-3");
});

test("core.card.menu group opens the plugin menu whose item groups the card with a new card toward its longer axis", { timeout: 5000 }, async () => {
  arrange();
  await run("core.card.menu", { card: "card-3", menu: "group" });
  assert.equal(plane.pickerState().open, true);
  await pick(PLAIN);
  const tree = plane.currentTree();
  const made = tree.parentOf("card-3");
  assert.ok(made, "card-3 is a member of a new group card");
  assert.equal(made.members.length, 2);
  // card-3 is drawn higher than wide, so the new card stands below it.
  const born = made.members.find((member) => member !== "card-3");
  assert.equal(tree.neighbour("card-3", "bottom"), born);
});

test("core.card.menu on a group card opens the menu of its header, whose items act on the group card", { timeout: 5000 }, async () => {
  arrange();
  await run("core.card.menu", { card: "card-4", menu: "add" });
  assert.equal(plane.pickerState().open, true, "the add menu of the group header is open");
  await pick(PLAIN);
  assert.equal(plane.currentTree().node("card-4").members.length, 3, "the add menu adds a content card inside the group card");
  arrange();
  await run("core.card.menu", { card: "card-4", menu: "split-y" });
  await pick(PLAIN);
  assert.equal(plane.currentTree().node("card-4").members.length, 2, "a split of the group card puts the new card beside it");
  assert.equal(plane.currentTree().levelMembers(null).length, 3);
});

const status = async (name) => (await registry.handle({ id: 1, method: "status.get", params: { name } })).result;

test("core.grid reports the drawn rectangle of each card and group card, and the fullscreen layout of a group card", { timeout: 5000 }, async () => {
  arrange();
  const tree = plane.currentTree();
  const reported = async () => new Map((await status("core.grid")).cards.map(({ id, x, y, w, h, fullscreen }) => [id, { x, y, w, h, fullscreen }]));
  let cards = await reported();
  for (const id of ["card-1", "card-2", "card-3", "card-4"]) near(cards.get(id), tree.rect(id), `the reported rectangle of ${id}`);
  await run("core.card.fullscreen", { card: "card-4" });
  const grid = plane.currentGrid();
  const shown = tree.fullscreen("card-4", { x: 0, y: 0, w: grid.width, h: grid.height });
  cards = await reported();
  for (const id of ["card-1", "card-2", "card-4"]) near(cards.get(id), shown.get(id), `the reported fullscreen rectangle of ${id}`);
  near(cards.get("card-3"), { x: 0, y: 0, w: 0, h: 0 }, "the reported rectangle of card-3 outside the fullscreen group card");
  assert.equal(cards.get("card-4").fullscreen, true);
  await run("core.card.fullscreen", { card: "card-4" });
});

test("the layout of the window snapshot gives each card and group card the frame that the plane draws", { timeout: 5000 }, async () => {
  arrange();
  await run("core.card.fullscreen", { card: "card-4" });
  const grid = plane.currentGrid();
  const shown = plane.currentTree().fullscreen("card-4", { x: 0, y: 0, w: grid.width, h: grid.height });
  const { root, groups } = plane.layoutDescription();
  const frame = ({ x, y, width, height }) => ({ x, y, w: width, h: height });
  // A group card is a node of the tree that holds the tree of its members (docs/spec/groups.md#status-and-queries).
  const leaves = (node) => ("children" in node ? node.children.flatMap(leaves) : node.group ? leaves(node.group.root) : [node]);
  const frames = new Map(leaves(root).map((leaf) => [leaf.card, frame(leaf.frame)]));
  for (const id of ["card-1", "card-2"]) near(frames.get(id), shown.get(id), `the snapshot frame of ${id}`);
  near(frames.get("card-3"), { x: 0, y: 0, w: 0, h: 0 }, "the snapshot frame of card-3 outside the fullscreen group card");
  near(frame(groups[0].frame), shown.get("card-4"), "the snapshot frame of card-4");
  await run("core.card.fullscreen", { card: "card-4" });
});

test("the leader keeps its leader mark in a head too narrow for its tools, and its tool menu does not hold it", { timeout: 5000 }, async () => {
  arrange();
  // JSDOM has no layout engine: each head is narrower than its tool row, so its tools fold into the menu.
  for (const id of ["card-1", "card-2"]) {
    const chrome = cardElement(id).querySelector(".chrome");
    Object.defineProperty(chrome, "clientWidth", { value: 120, configurable: true });
    const acts = chrome.querySelector(".chrome__acts");
    acts.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24 });
  }
  await run("core.card.focus", { card: "card-2" });
  plane.settle();
  const chrome = (id) => cardElement(id).querySelector(".chrome");
  assert.equal(chrome("card-1").dataset.tools, "menu", "the head of card-1 is not folded");
  assert.equal(chrome("card-1").dataset.mark, "leader", "the head of the leader card-1 does not keep its leader mark");
  assert.equal(chrome("card-2").dataset.mark, undefined, "the head of card-2, which does not lead, keeps a leader mark");
  assert.equal(plane.cardActs("card-1").leader.hidden, false, "core.grid reports the leader mark of card-1 hidden");
  assert.equal(plane.cardActs("card-2").leader.hidden, true, "core.grid reports the leader button of card-2 shown in its folded head");
  await run("core.card.tools", { card: "card-1" });
  assert.equal(plane.pickerState().items.some((item) => item.key === "leader"), false, "the tool menu of the leader holds its mark");
});
