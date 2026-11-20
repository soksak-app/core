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
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: PLAIN, title: "t" }] } } },
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
const content = (id, tabs) => ({ card: id, data: { tabs, activeId: tabs[0].id } });
/** A box of the group card id with its name and leader around the cut along x of the kids, each [share, node]. */
const box = (id, name, leader, kids) => ({ box: id, data: { name, leader }, inner: row(kids) });
/** A cut along x of the kids, each [share, node]. */
const row = (kids) => ({ cut: "x", kids: kids.map(([share, node]) => ({ share, node })) });
begin({ common: {}, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main",
    lastCard: 1, state: { root: content("main", [view("tab-aaaaa1", PLAIN)]) } } },
  { id: "spc-bbbbbb", title: "SPACE2", layout: { focusedId: "card-8", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 10, leader: "card-10",
    state: { root: box("card-10", "그룹 1", "card-8", [[0.5, content("card-8", [view("tab-ooooo1", PLAIN)])], [0.5, content("card-9", [view("tab-ooooo2", PLAIN)])]]) } } },
], activeSpaceId: "spc-aaaaaa", named: 2 }] });

/** Shows three cards in a row, card-1, card-2 and card-3, whose first two are the group card-4 named 그룹 1, with card-1 focused. */
function arrange() {
  plane.closePicker("fixture reset");
  if (plane.currentGrid()) for (const card of plane.currentGrid().cards) for (const tab of plane.tabsOf(card)) reports.forgetTab(tab.id);
  plane.adopt({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 4, leader: "card-4",
    state: { root: row([
      [0.75, box("card-4", "그룹 1", "card-1", [[0.5, content("card-1", [view("tab-aaaaa1", PLAIN)])], [0.5, content("card-2", [view("tab-aaaaa2", PLAIN)])]])],
      [0.25, content("card-3", [view("tab-aaaaa3", PLAIN)])],
    ]) } }, "spc-aaaaaa");
}
const run = (name, params) => registry.run(name, params);
const refuses = (promise, text) => assert.rejects(promise, (error) => error.message === text, `does not fail with ${text}`);
const status = async (name) => (await registry.handle({ id: 1, method: "status.get", params: { name } })).result;
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
const stored = async () => {
  const { state, leader, lastCard } = await status("core.layout");
  return { groups: groupsOf(state.root), leader, lastCard };
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

// With request, core.group.create is idempotent by that request: a new request groups the card again where its group stands, a repeat
// of an answered request answers its first answer and changes nothing, and a request that is no string of 1 to 128 characters is
// refused (docs/spec/groups.md#idempotency).
test("a request makes core.group.create idempotent by that request", { timeout: 5000 }, async () => {
  arrange();
  const first = await run("core.group.create", { card: "card-3", side: "bottom", plugin: PLAIN, request: "r1" });
  const second = await run("core.group.create", { card: "card-3", side: "bottom", plugin: PLAIN, request: "r2" });
  assert.notDeepEqual(second, first, "a new request answered the first answer");
  const before = await stored();
  assert.deepEqual(await run("core.group.create", { card: "card-3", side: "bottom", plugin: PLAIN, request: "r1" }), first);
  assert.deepEqual(await stored(), before, "the repeat of an answered request changed the layout");
  // A request that is no string is refused by the declared params of the command before it runs (F967).
  for (const request of ["", "r".repeat(129)]) {
    await refuses(run("core.group.create", { card: "card-3", side: "bottom", plugin: PLAIN, request }),
      "core.group.create: request must be a string of 1 to 128 characters");
  }
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
  // The split of a group card puts the new card beside its box in the level that holds it, so the cards inside keep their tree.
  const split = await run("core.card.split", { card: "card-4", side: "bottom", plugin: PLAIN });
  assert.equal(split.card, "card-6");
  assert.deepEqual((await stored()).groups[0].members, ["card-1", "card-2", "card-5", "card-3"]);
  assert.deepEqual((await status("core.layout")).state.root.kids.map((kid) => kid.node.box ?? kid.node.card), ["card-4", "card-6"]);
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
    card: "card-4", groups: [], focus: 1, group: { name: "그룹 1", level: 1, leader: "card-1", members: ["card-1", "card-2"] },
  });
  await refuses(run("core.card.get", { card: "card-99" }), "card card-99 is not in the layout of window main");
});

test("core.grid lists the content cards with their tabs in cards and the group cards in groups", { timeout: 5000 }, async () => {
  arrange();
  // The content cards come in workbench order, each with its tabs, parent, null at the root level, and leader a boolean, and the group
  // cards stand in groups, so a reader of cards sees one shape (docs/spec/groups.md#status-and-queries).
  plane.adopt({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 4, leader: "card-3",
    state: { root: row([
      [0.25, content("card-3", [view("tab-aaaaa3", PLAIN)])],
      [0.75, box("card-4", "그룹 1", "card-1", [[1 / 3, content("card-1", [view("tab-aaaaa1", PLAIN)])], [2 / 3, content("card-2", [view("tab-aaaaa2", PLAIN)])]])],
    ]) } }, "spc-aaaaaa");
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

test("core.layout.balance in a space with groups gives every child of every cut an equal share, a group card as one child", { timeout: 5000 }, async () => {
  plane.closePicker("fixture reset");
  plane.adopt({ focusedId: "card-9", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 13, leader: "card-12",
    state: { root: { cut: "y", kids: [
      { share: 0.33085808580858084, node: box("card-12", "그룹 1", "browser", [[0.6680017801513128, content("browser", [view("tab-bbbbb2", PLAIN)])],
        [0.33199821984868716, content("card-13", [view("tab-bbbbb6", PLAIN)])]]) },
      { share: 0.6691419141914192, node: row([
        [0.6680017801513128, { cut: "y", kids: [
          { share: 0.5055487053020963, node: box("card-10", "그룹 3", "card-9", [[0.4970019986675549, content("card-9", [view("tab-bbbbb3", PLAIN)])],
            [0.5029980013324451, content("card-11", [view("tab-bbbbb4", PLAIN)])]]) },
          { share: 0.4944512946979037, node: content("card-7", [view("tab-bbbbb5", PLAIN)]) },
        ] }],
        [0.33199821984868716, content("terminal", [view("tab-bbbbb1", PLAIN)])],
      ]) },
    ] } } }, "spc-aaaaaa");
  await run("core.layout.balance", {});
  const tree = plane.currentTree();
  const same = (ids, key) => {
    const sizes = ids.map((id) => tree.rect(id)[key]);
    for (const size of sizes) assert.ok(Math.abs(size - sizes[0]) < 1e-6, `${ids} are drawn ${key} ${sizes}, not one size`);
  };
  // The plane is a column of the group card card-12 and a row of the column of card-10 and card-7 beside terminal; the frames and the
  // header of a group card are fixed costs of its cut, so the members of a group card are drawn at the size of the children beside it, as
  // the balance cases of docs/spec/cases/layout/groups.json state.
  same(["browser", "terminal"], "h");
  same(["card-10", "terminal"], "w");
  same(["card-9", "card-7"], "h");
  same(["browser", "card-13"], "w");
  same(["card-9", "card-11"], "w");
});
