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
  // The split of a group card puts the new card beside its box in the level that holds it, so the cards inside keep their tree. The box is
  // the whole root, so the ADD across it wraps the box and the new card in a cut of two halves.
  const split = await run("core.card.split", { card: "card-4", side: "right", plugin: PLAIN });
  assert.equal(split.card, "card-6");
  // The halves take one fraction each, so the new card is drawn at the width of the content of the box, whose frames are costs of the cut.
  assert.deepEqual(plane.currentGrid().rect("card-4"), { x: 0, y: 0, w: 806, h: 1200 });
  assert.deepEqual(plane.currentGrid().rect("card-6"), { x: 818, y: 0, w: 782, h: 1200 });
  assert.deepEqual((await stored()).groups[0].members, ["card-1", "card-2", "card-5", "card-3"]);
  assert.deepEqual((await status("core.layout")).state.root.kids.map((kid) => kid.node.box ?? kid.node.card), ["card-4", "card-6"]);
  assert.deepEqual(await run("core.card.close", { card: "card-4" }), { closed: true });
  assert.deepEqual(await stored(), { groups: [], leader: "card-6", lastCard: 6 });
  assert.deepEqual(plane.currentGrid().cards.map((card) => card.id), ["card-6"]);
});

// A group card too narrow for the ADD beside its box is refused with the deepest node that the split would draw below its minimum, and
// nothing changes.
test("a split of a group card too narrow for the new card names the card inside it that would be drawn below its minimum", { timeout: 5000 }, async () => {
  arrange();
  plane.adopt({ focusedId: "card-3", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 4, leader: "card-3",
    state: { root: row([
      [0.85, content("card-3", [view("tab-aaaaa3", PLAIN)])],
      [0.15, box("card-4", "그룹 1", "card-1", [[0.5, content("card-1", [view("tab-aaaaa1", PLAIN)])], [0.5, content("card-2", [view("tab-aaaaa2", PLAIN)])]])],
    ]) } }, "spc-aaaaaa");
  const before = await status("core.layout");
  await refuses(run("core.card.split", { card: "card-4", side: "right", plugin: PLAIN }),
    "card card-4 cannot split toward right: card card-1 would be 52x1144, below its minimum 96x96");
  assert.deepEqual(await status("core.layout"), before, "the refused split changed the layout");
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

test("a drag along the bottom line selects the run from the card where it entered the line to the current card", { timeout: 5000 }, () => {
  arrange();
  const band = plane.dropBands();
  const first = plane.currentTree().rect("card-1"), second = plane.currentTree().rect("card-2");
  // The bottom line of card-1 holds four bands, the root cut, the group card, the cut of its members and card-1; the innermost band is
  // 15 to 20 points inside the line (docs/spec/groups.md#target-search).
  const y = 1200 - 17;
  const entered = plane.dragHit(null, first.x + first.w / 2, y, band);
  assert.deepEqual(entered.hit, { card: "card-1", zone: "bottom" });
  const along = plane.dragHit(entered.anchor, second.x + second.w / 2, y, band);
  assert.deepEqual(along.hit, { card: ["card-1", "card-2"], zone: "bottom" });
  assert.deepEqual(along.anchor, entered.anchor, "the drag that stays on the band keeps its anchor");
  // Without the anchor the same point is the band of card-2 alone.
  assert.deepEqual(plane.dropHit(second.x + second.w / 2, y, band), { card: "card-2", zone: "bottom" });
});

test("a drop resolves by the bands of the target search and core.tab.move puts a tab into and beside a group card", { timeout: 5000 }, async () => {
  arrange();
  const tree = plane.currentTree();
  const band = plane.dropBands();
  const group = tree.rect("card-4");
  const first = tree.rect("card-1");
  // The header of a group card is the add to the right of the root of its plane, the members of the group; a point on the left line of
  // the group card is in the band of the group card, the outermost node on that line, and a point in the outer quarter of the body of
  // card-1 is the side of card-1 (docs/spec/groups.md#target-search).
  assert.deepEqual(plane.dropHit(group.x + group.w / 2, group.y + 1, band), { card: ["card-1", "card-2"], zone: "right" });
  assert.deepEqual(plane.dropHit(group.x + 2, group.y + group.h / 2, band), { card: "card-4", zone: "left" });
  assert.deepEqual(plane.dropHit(group.x + group.w * 0.4, first.y + first.h / 2, band), { card: "card-1", zone: "right" });
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

/** The tab ids of the content card id in their order. */
const tabIds = (id) => plane.tabsOf(plane.currentGrid().card(id)).map((t) => t.id);

test("core.card.move exchanges a card with a content card and joins its tabs at an index of a tab strip", { timeout: 5000 }, async () => {
  arrange();
  // The two cards exchange places, and the leader mark of the group stays with its place (docs/spec/groups.md#commands).
  assert.deepEqual(await run("core.card.move", { card: "card-3", target: "card-1", side: "centre" }), { card: "card-3" });
  assert.deepEqual((await stored()).groups, [{ card: "card-4", name: "그룹 1", level: 1, leader: "card-3", members: ["card-3", "card-2"] }]);
  // Each place keeps the size it is drawn at; the shares are computed again from those sizes, so they are compared to 9 digits.
  assert.deepEqual((await status("core.layout")).state.root.kids.map((kid) => Number(kid.share.toFixed(9))), [0.75, 0.25], "each place keeps its size");
  // An exchange applied again exchanges them back.
  await run("core.card.move", { card: "card-3", target: "card-1", side: "centre" });
  assert.deepEqual((await stored()).groups[0], { card: "card-4", name: "그룹 1", level: 1, leader: "card-1", members: ["card-1", "card-2"] });
  await refuses(run("core.card.move", { card: "card-3", target: ["card-1", "card-2"], side: "centre" }),
    "card card-3 moves to the centre of one card, not of card-1, card-2");
  await refuses(run("core.card.move", { card: "card-3", target: ["card-1", "card-2"], side: "strip", index: 0 }),
    "card card-3 moves to the strip of one card, not of card-1, card-2");
  await refuses(run("core.card.move", { card: "card-4", target: "card-3", side: "strip", index: 0 }), "card card-4 is a group and holds no tabs");
  await refuses(run("core.card.move", { card: "card-3", target: "card-4", side: "strip", index: 0 }), "card card-4 is a group and has no tab strip");
  await refuses(run("core.card.move", { card: "card-3", target: "card-1", side: "right", index: 0 }), "index is given with side strip only");
  await refuses(run("core.card.move", { card: "card-3", target: "card-1", side: "strip" }), "index is required with side strip");
  await refuses(run("core.card.move", { card: "card-3", target: "card-1", side: "strip", index: 2 }), "index 2 is outside the tabs of card card-1, 0 to 1");
  // Every tab of the card joins the target at the index in its order, and the card is closed.
  const { tab } = await run("core.card.add-tab", { card: "card-3", plugin: PLAIN });
  assert.deepEqual(await run("core.card.move", { card: "card-3", target: "card-1", side: "strip", index: 0 }), { card: "card-3" });
  assert.deepEqual(tabIds("card-1"), ["tab-aaaaa3", tab, "tab-aaaaa1"]);
  assert.equal(plane.currentGrid().card("card-3"), undefined, "the card that joined is closed");
});

test("core.tab.move joins a tab at the index of a tab strip, and a point on a tab strip names the index of the tabs before it", { timeout: 5000 }, async () => {
  arrange();
  const { tab } = await run("core.card.add-tab", { card: "card-1", plugin: PLAIN });
  await run("core.card.add-tab", { card: "card-2", plugin: PLAIN });
  // The index is the place in the tab list of the card after the tab leaves it (docs/spec/groups.md#moving-and-dropping).
  await run("core.tab.move", { tab: "tab-aaaaa1", card: "card-1", zone: "strip", index: 1 });
  assert.deepEqual(tabIds("card-1"), [tab, "tab-aaaaa1"]);
  await run("core.tab.move", { tab: "tab-aaaaa3", card: "card-1", zone: "strip", index: 1 });
  assert.deepEqual(tabIds("card-1"), [tab, "tab-aaaaa3", "tab-aaaaa1"]);
  assert.equal(plane.currentGrid().card("card-3"), undefined, "the card left without tabs is removed");
  assert.equal(plane.currentGrid().card("card-1").data.activeId, "tab-aaaaa3", "the moved tab is the selected tab of the card");
  await refuses(run("core.tab.move", { tab, card: "card-2", zone: "strip", index: 3 }), "index 3 is outside the tabs of card card-2, 0 to 2");
  await refuses(run("core.tab.move", { tab, card: "card-1", zone: "strip", index: 3 }), "index 3 is outside the tabs of card card-1, 0 to 2");
  await refuses(run("core.tab.move", { tab, card: "card-2", zone: "centre", index: 0 }), "index is given with zone strip only");
  await refuses(run("core.tab.move", { tab, card: "card-2", zone: "strip" }), "index is required with zone strip");
  await refuses(run("core.tab.move", { tab, card: "card-4", zone: "strip", index: 0 }), "card card-4 is a group and has no tab strip");
  await refuses(run("core.tab.move", { tab, card: ["card-1", "card-2"], zone: "strip", index: 0 }),
    "tab " + tab + " moves to the strip of one card, not of card-1, card-2");
  // JSDOM draws no layout: each tab of card-1 is given a rectangle 100 points wide on its strip, so their middles are 60, 160 and 260
  // points right of the card.
  const first = plane.currentTree().rect("card-1");
  const tabs = [...document.querySelectorAll(`.card[data-card-id="card-1"] .chrome__tabs .tab[data-tab-id]`)];
  assert.equal(tabs.length, 3);
  tabs.forEach((element, i) => {
    element.getBoundingClientRect = () => ({ left: first.x + 10 + 100 * i, top: first.y, width: 100, height: 30, right: first.x + 110 + 100 * i, bottom: first.y + 30 });
  });
  const band = plane.dropBands();
  const y = first.y + band.headerPx - 2;
  assert.deepEqual(plane.dropHit(first.x + 170, y, band), { card: "card-1", zone: "strip", index: 2 });
  // The moving tab is left out of the count.
  assert.deepEqual(plane.dragHit(null, first.x + 170, y, band, tab).hit, { card: "card-1", zone: "strip", index: 1 });
});

/** Sends the pointer event type at x, y of the plane to element, which captures the pointer as a press of a person does; jsdom does not. */
const pointer = (element, type, x, y) => {
  element.setPointerCapture ??= () => {};
  element.hasPointerCapture ??= () => true;
  element.releasePointerCapture ??= () => {};
  element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y }));
};
/** The ids of the kids of the root cut of the stored layout. */
const rootKids = async () => (await status("core.layout")).state.root.kids.map((kid) => kid.node.box ?? kid.node.card);

test("a drag of the header of a group card moves the group card beside a card and exchanges it on the centre of a content card", { timeout: 5000 }, async () => {
  arrange();
  const head = () => document.querySelector(`.group[data-group-card="card-4"] > .group__head`);
  const drag = async (to) => {
    const group = plane.currentTree().rect("card-4");
    pointer(head(), "pointerdown", group.x + 30, group.y + 10);
    pointer(head(), "pointermove", to.x, to.y);
    const during = await status("core.drag");
    pointer(head(), "pointerup", to.x, to.y);
    return during;
  };
  // A press on a button of the header starts no drag.
  pointer(head().querySelector("button"), "pointerdown", 10, 10);
  assert.equal(await status("core.drag"), null, "a press on a header button started a drag");
  const third = plane.currentTree().rect("card-3");
  const beside = await drag({ x: third.x + third.w - 40, y: third.y + third.h / 2 });
  assert.deepEqual([beside.tab, beside.card, beside.moved, beside.target], ["", "card-4", true, { card: "card-3", zone: "right" }]);
  assert.notEqual(beside.preview, null, "the drag shows the drop preview");
  assert.deepEqual(await rootKids(), ["card-3", "card-4"]);
  // On the centre of a content card the group card exchanges places with it (docs/spec/groups.md#moving-and-dropping).
  const left = plane.currentTree().rect("card-3");
  const centre = await drag({ x: left.x + left.w / 2, y: left.y + left.h / 2 });
  assert.deepEqual(centre.target, { card: "card-3", zone: "centre" });
  assert.deepEqual(await rootKids(), ["card-4", "card-3"]);
  assert.equal(await status("core.drag"), null, "the release ends the drag");
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
