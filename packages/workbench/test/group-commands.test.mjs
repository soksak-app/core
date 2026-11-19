// The group commands, the card query and the group members of the statuses of the page workbench (docs/spec/groups.md#commands,
// docs/spec/groups.md#status-and-queries), run through the registry of the page without a host, as in the browser runtime. The plane of
// each test holds one group card of two cards beside a card of the root level.
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
}
const run = (name, params) => registry.run(name, params);
const refuses = (promise, text) => assert.rejects(promise, (error) => error.message === text, `does not fail with ${text}`);
const status = async (name) => (await registry.handle({ id: 1, method: "status.get", params: { name } })).result;
const stored = async () => {
  const { groups, leader, lastCard } = await status("core.layout");
  return { groups, leader, lastCard };
};

test("core.group.create groups a content card with a new card and answers the same when applied again", { timeout: 5000 }, async () => {
  arrange();
  const made = await run("core.group.create", { card: "card-3", side: "bottom", plugin: SESSION, params: { name: "a" } });
  assert.deepEqual([made.group, made.card], ["card-5", "card-6"]);
  assert.equal(plane.focused(), "card-6");
  assert.deepEqual(await run("core.group.create", { card: "card-3", side: "bottom", plugin: SESSION, params: { name: "a" } }), made);
  assert.deepEqual(await stored(), {
    groups: [
      { card: "card-4", name: "그룹 1", level: 1, leader: "card-1", members: ["card-1", "card-2"] },
      { card: "card-5", name: "그룹 2", level: 1, leader: "card-3", members: ["card-3", "card-6"] },
    ],
    leader: "card-4", lastCard: 6,
  });
  await refuses(run("core.group.create", { card: "card-1", side: "right", plugin: "fixture-gone" }), "unknown plugin fixture-gone");
  assert.equal((await stored()).lastCard, 6, "a refused group issued a card number");
});

test("core.group.dissolve, rename and leader change the tree and answer again without a change", { timeout: 5000 }, async () => {
  arrange();
  assert.deepEqual(await run("core.group.rename", { group: "card-4", name: "  작업  " }), { group: "card-4", name: "작업" });
  await refuses(run("core.group.rename", { group: "card-1", name: "x" }), "card card-1 is not a group");
  assert.deepEqual(await run("core.group.leader", { card: "card-2" }), { card: "card-2", group: "card-4" });
  // The declaration of the result names the members that the command answers.
  const declared = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes.commands.find(({ name }) => name === "core.group.leader");
  assert.deepEqual(Object.keys(declared.result.properties), ["card", "group"]);
  assert.deepEqual(await run("core.group.leader", { card: "card-3" }), { card: "card-3", group: null });
  assert.equal((await stored()).groups[0].leader, "card-2");
  assert.deepEqual(await run("core.group.dissolve", { group: "card-4" }), { dissolved: true });
  assert.deepEqual(await run("core.group.dissolve", { group: "card-4" }), { dissolved: true });
  assert.deepEqual(await stored(), { groups: [], leader: "card-3", lastCard: 4 });
  await refuses(run("core.group.dissolve", { group: "card-99" }), "card card-99 is not in the layout of window main");
  await refuses(run("core.group.dissolve", { group: "card-10" }), "card card-10 is in space spc-bbbbbb, which is not active");
});

test("core.card.move moves a card into a group and the add, split and close of a group card act on its rectangle", { timeout: 5000 }, async () => {
  arrange();
  const { tab } = await run("core.card.add-tab", { card: "card-4", plugin: PLAIN });
  assert.equal(plane.currentGrid().cards.find((card) => plane.tabsOf(card).some((t) => t.id === tab)).id, "card-5");
  assert.deepEqual((await stored()).groups[0].members, ["card-1", "card-2", "card-5"]);
  assert.deepEqual(await run("core.card.move", { card: "card-3", target: "card-4", side: "centre" }), { card: "card-3" });
  assert.deepEqual(await run("core.card.move", { card: "card-3", target: "card-4", side: "centre" }), { card: "card-3" });
  assert.deepEqual((await stored()).groups[0].members, ["card-1", "card-2", "card-5", "card-3"]);
  await refuses(run("core.card.move", { card: "card-4", target: "card-1", side: "right" }), "card card-4 cannot move into itself");
  await refuses(run("core.card.split", { card: "card-4", side: "right", plugin: PLAIN }),
    "card card-4 cannot split toward right: card card-1 would be 57x1144, below its minimum 96x96");
  const split = await run("core.card.split", { card: "card-4", side: "bottom", plugin: PLAIN });
  assert.equal(split.card, "card-6");
  assert.deepEqual((await stored()).groups[0].members, ["card-1", "card-2", "card-5", "card-3"]);
  assert.deepEqual(await run("core.card.close", { card: "card-4" }), { closed: true });
  assert.deepEqual(await stored(), { groups: [], leader: "card-6", lastCard: 6 });
  assert.deepEqual(plane.currentGrid().cards.map((card) => card.id), ["card-6"]);
});

test("core.layout.open on a group card selects an equal tab inside it, adds a card to it and splits its rectangle", { timeout: 5000 }, async () => {
  arrange();
  // The first equal tab among the content cards inside the group card in workbench order is selected.
  assert.deepEqual(await run("core.layout.open", { card: "card-4", plugin: PLAIN }), { card: "card-1", tab: "tab-aaaaa1" });
  // Otherwise a content card with the tab is added inside the group card, and the same open answers the same.
  const added = await run("core.layout.open", { card: "card-4", plugin: SESSION, params: { name: "a" } });
  assert.equal(added.card, "card-5");
  assert.equal(plane.focused(), "card-5");
  assert.deepEqual((await stored()).groups[0].members, ["card-1", "card-2", "card-5"]);
  assert.deepEqual(await run("core.layout.open", { card: "card-4", plugin: SESSION, params: { name: "a" } }), added);
  // With side the rectangle of the group card splits toward side in the level that holds it; the neighbour of a content card is a
  // member of its level, so the same open selects the tab of the new card.
  const below = await run("core.layout.open", { card: "card-4", plugin: SESSION, params: { name: "b" }, side: "bottom" });
  assert.equal(below.card, "card-6");
  assert.equal((await stored()).groups[0].members.includes("card-6"), false);
  assert.deepEqual(await run("core.layout.open", { card: "card-4", plugin: SESSION, params: { name: "b" }, side: "bottom" }), below);
  await refuses(run("core.layout.open", { card: "card-10", plugin: PLAIN }), "card card-10 is in space spc-bbbbbb, which is not active");
});

test("core.layout.open toward a side from the last card of a group finds its neighbour only inside the group", { timeout: 5000 }, async () => {
  arrange();
  // card-3 outside the group holds a tab of the same plugin on the line of the right edge of card-2, so a neighbour of the whole grid
  // would select it; the neighbour is a member of the level of card-2, so the open adds a card to the group
  // (docs/spec/groups.md#card-commands-on-a-group-card).
  const opened = await run("core.layout.open", { card: "card-2", side: "right", plugin: PLAIN });
  assert.notEqual(opened.card, "card-3", "the open left the group for the card outside it");
  assert.deepEqual((await stored()).groups[0].members, ["card-1", "card-2", opened.card]);
});

test("a drop resolves on the rectangles of the group cards and core.tab.move puts a tab into and beside a group card", { timeout: 5000 }, async () => {
  arrange();
  const tree = plane.currentTree();
  const band = plane.dropBands();
  const group = tree.rect("card-4");
  const first = tree.rect("card-1");
  // The header of a group card is its centre, the outer quarter of its rectangle a side, and a point inside goes on to its members.
  assert.deepEqual(plane.dropHit(group.x + group.w / 2, group.y + 1, "card-3", band), { id: "card-4", zone: "centre" });
  assert.deepEqual(plane.dropHit(group.x + 2, group.y + group.h / 2, "card-3", band), { id: "card-4", zone: "left" });
  // A point of card-1 outside the outer quarter of the group card resolves on card-1 by zoneAt.
  assert.deepEqual(plane.dropHit(group.x + group.w * 0.4, first.y + first.h / 2, "card-3", band), { id: "card-1", zone: "right" });
  // A drop on the centre of a group card puts the tab into a new content card inside it; the only tab of a card moves its card.
  const { tab } = await run("core.card.add-tab", { card: "card-3", plugin: PLAIN });
  await run("core.tab.move", { tab, card: "card-4", zone: "centre" });
  assert.equal(plane.currentGrid().cards.find((card) => plane.tabsOf(card).some((t) => t.id === tab)).id, "card-5");
  assert.deepEqual((await stored()).groups[0].members, ["card-1", "card-2", "card-5"]);
  // A drop on a side of a group card puts the card beside the rectangle of the group card in the level that holds it.
  await run("core.tab.move", { tab: "tab-aaaaa3", card: "card-4", zone: "bottom" });
  const moved = plane.currentGrid().card("card-3");
  const box = plane.currentTree().rectangle(plane.currentTree().node("card-4"));
  assert.deepEqual([moved.c0, moved.c1, moved.r0], [box.c0, box.c1, box.r1]);
  assert.deepEqual((await stored()).groups[0].members, ["card-1", "card-2", "card-5"]);
});

test("the layout of the window description holds each group card as a node of its tree and lists every group once", { timeout: 5000 }, async () => {
  arrange();
  // card-2 becomes the group card card-5 with card-6 below it, nested in card-4 (docs/spec/groups.md#status-and-queries).
  await run("core.group.create", { card: "card-2", side: "bottom", plugin: PLAIN });
  const { root, groups } = plane.layoutDescription();
  const shape = (node) => (node.children ? { direction: node.direction, children: node.children.map(shape) }
    : node.group ? { card: node.card, leader: node.leader, group: { name: node.group.name, level: node.group.level, leader: node.group.leader,
      root: shape(node.group.root) } }
    : { card: node.card, parent: node.parent, leader: node.leader });
  assert.deepEqual(shape(root), { direction: "row", children: [
    { card: "card-4", leader: true, group: { name: "그룹 1", level: 1, leader: "card-1", root: { direction: "row", children: [
      { card: "card-1", parent: "card-4", leader: true },
      { card: "card-5", leader: false, group: { name: "그룹 2", level: 2, leader: "card-2", root: { direction: "column", children: [
        { card: "card-2", parent: "card-5", leader: true }, { card: "card-6", parent: "card-5", leader: false }] } } }] } } },
    { card: "card-3", parent: null, leader: false }] });
  const { x, y, w, h } = plane.currentTree().rect("card-4");
  const origin = document.getElementById("plane").getBoundingClientRect();
  assert.deepEqual(groups.map(({ card, members }) => ({ card, members })), [{ card: "card-4", members: ["card-1", "card-5"] },
    { card: "card-5", members: ["card-2", "card-6"] }], "the description does not list every group card once with the identifiers of its members");
  assert.deepEqual(groups[0], { card: "card-4", name: "그룹 1", level: 1, leader: "card-1", leading: true,
    frame: { x: origin.left + x, y: origin.top + y, width: w, height: h }, members: ["card-1", "card-5"] });
});

test("core.card.get reads a content card with its group path and a group card with its node", { timeout: 5000 }, async () => {
  arrange();
  assert.deepEqual(await run("core.card.get", { card: "card-2" }), {
    card: "card-2", activeTab: "tab-aaaaa2", tabs: [{ tab: "tab-aaaaa2", plugin: PLAIN, status: {} }], groups: [{ card: "card-4", name: "그룹 1" }],
  });
  assert.deepEqual(await run("core.card.get", { card: "card-4" }), {
    card: "card-4", groups: [], group: { name: "그룹 1", level: 1, leader: "card-1", members: ["card-1", "card-2"] },
  });
  await refuses(run("core.card.get", { card: "card-99" }), "card card-99 is not in the layout of window main");
});

test("core.grid lists the content cards with their tabs in cards and the group cards in groups", { timeout: 5000 }, async () => {
  arrange();
  // The content cards come in workbench order, each with its tabs, parent, null at the root level, and leader a boolean, and the group
  // cards stand in groups, so a reader of cards sees one shape (docs/spec/groups.md#status-and-queries).
  plane.adopt({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 4, leader: "card-3",
    groups: [{ card: "card-4", name: "그룹 1", leader: "card-1", members: ["card-1", "card-2"] }],
    state: { xs: [0, 0.25, 0.5, 1], ys: [0, 1], cards: [content("card-3", 0, 1, 0, 1, [view("tab-aaaaa3", PLAIN)]),
      content("card-1", 1, 2, 0, 1, [view("tab-aaaaa1", PLAIN)]), content("card-2", 2, 3, 0, 1, [view("tab-aaaaa2", PLAIN)])] } }, "spc-aaaaaa");
  const { cards, groups } = await status("core.grid");
  assert.deepEqual(cards.map(({ id, parent, leader }) => ({ id, parent, leader })), [
    { id: "card-3", parent: null, leader: true }, { id: "card-1", parent: "card-4", leader: true },
    { id: "card-2", parent: "card-4", leader: false },
  ], "core.grid lists another card than the content cards in cards");
  for (const card of cards) assert.ok(Array.isArray(card.tabs), `the card ${card.id} of core.grid has no tabs`);
  assert.deepEqual(Object.keys(cards[0]).filter((key) => ["parent", "leader", "group"].includes(key)), ["parent", "leader"]);
  assert.equal(groups?.length, 1, "core.grid lists no group card in groups");
  const { x, y, w, h, ...group } = groups[0];
  assert.deepEqual(group, { id: "card-4", parent: null, leader: false, group: { name: "그룹 1", level: 1, leader: "card-1" } });
  assert.deepEqual({ x, y, w, h }, plane.currentTree().rect("card-4"));
});

test("core.layout.balance in a space with groups keeps every line index and gives the cards of a row equal shares", { timeout: 5000 }, async () => {
  plane.closePicker("fixture reset");
  plane.adopt({ focusedId: "card-9", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 13, leader: "card-12",
    groups: [{ card: "card-12", name: "그룹 1", leader: "browser", members: ["browser", "card-13"] },
      { card: "card-10", name: "그룹 3", leader: "card-9", members: ["card-9", "card-11"] }],
    state: { xs: [0, 0.3319982198486871, 0.6680017801513128, 1], ys: [0, 0.33085808580858084, 0.6691419141914192, 1], cards: [
      content("terminal", 2, 3, 1, 3, [view("tab-bbbbb1", PLAIN)]), content("browser", 0, 2, 0, 1, [view("tab-bbbbb2", PLAIN)]),
      content("card-9", 0, 1, 1, 2, [view("tab-bbbbb3", PLAIN)]), content("card-11", 1, 2, 1, 2, [view("tab-bbbbb4", PLAIN)]),
      content("card-7", 0, 2, 2, 3, [view("tab-bbbbb5", PLAIN)]), content("card-13", 2, 3, 0, 1, [view("tab-bbbbb6", PLAIN)])] } }, "spc-aaaaaa");
  const place = () => plane.currentGrid().cards.map(({ id, c0, c1, r0, r1 }) => [id, c0, c1, r0, r1]);
  const before = place();
  await run("core.layout.balance", {});
  assert.deepEqual(place(), before, "the balance keeps every line index");
  const tree = plane.currentTree();
  const heights = ["browser", "card-9", "card-7"].map((id) => tree.rect(id).h);
  for (const h of heights) assert.ok(Math.abs(h - heights[0]) < 1e-6, `the rows are drawn ${heights}, not one height`);
  const widths = ["card-9", "card-11", "card-13"].map((id) => tree.rect(id).w);
  for (const w of widths) assert.ok(Math.abs(w - widths[0]) < 1e-6, `the columns are drawn ${widths}, not one width`);
});
