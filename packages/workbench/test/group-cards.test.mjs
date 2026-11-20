// The drawing of the group cards of the page workbench (docs/spec/groups.md#drawing): each group card is one container, its frame on the
// drawn rectangle of the group tree filled with the color of its level, its header the band of head-h at the top of the frame with the name and the
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
  plane.settle();
}
const run = (name, params) => registry.run(name, params);
const { currentGroupLook } = await import("../settings.js");

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
  probe.style.background = currentGroupLook(1).body;
  assert.equal(group.style.background, probe.style.background, "the frame is filled with the body of level 1");
  const header = group.querySelector('[data-expose="core.group.header"]');
  assert.ok(header, "the group card has its header");
  probe.style.backgroundColor = currentGroupLook(1).head;
  assert.equal(header.style.backgroundColor, probe.style.backgroundColor, "the header is drawn in the color of the head of a card");
  probe.style.borderBottomColor = currentGroupLook(1).line;
  assert.equal(header.style.borderBottomColor, probe.style.borderBottomColor, "the header draws the line below it in the color of groupLook");
  assert.equal(header.querySelector('[data-expose="core.group.name"]').textContent, "그룹 1");
  assert.deepEqual([...header.querySelectorAll(".chrome__act")].map((button) => button.dataset.expose),
    ["core.group.split-x", "core.group.split-y", "core.group.group-x", "core.group.group-y", "core.card.leader", "core.group.fullscreen",
      "core.group.close"]);
  assert.deepEqual([...header.querySelectorAll(".chrome__act")].map((button) => button.dataset.command),
    ["core.card.menu", "core.card.menu", "core.card.menu", "core.card.menu", "core.group.leader", "core.card.fullscreen", "core.group.menu"]);
  assert.deepEqual([...header.querySelectorAll(".chrome__act")].slice(0, 4).map((button) => JSON.parse(button.dataset.params).menu),
    ["split-x", "split-y", "group-x", "group-y"], "a group header holds the four split buttons and no add button");
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

/** The group card card-6 holds the group card card-5 of card-1 and card-2 and the card card-3, beside card-4 of the root level. */
function arrangeNested(focusedId) {
  plane.closePicker("fixture reset");
  if (plane.currentGrid()) for (const card of plane.currentGrid().cards) for (const tab of plane.tabsOf(card)) reports.forgetTab(tab.id);
  plane.adopt({ focusedId, named: 0, windowSidebars: {}, sidebars: {}, lastCard: 6, leader: "card-6",
    state: { root: row([
      [0.75, box("card-6", "그룹 2", "card-5", [
        [2 / 3, box("card-5", "그룹 1", "card-1", [[0.5, content("card-1", [view("tab-aaaaa1", PLAIN)])], [0.5, content("card-2", [view("tab-aaaaa2", PLAIN)])]])],
        [1 / 3, content("card-3", [view("tab-aaaaa3", PLAIN)])],
      ])],
      [0.25, content("card-4", [view("tab-aaaaa4", PLAIN)])],
    ]) } }, "spc-aaaaaa");
  plane.settle();
}

test("each group card that holds the focused card marks its frame with the focus faded by group-focus-fade for each level", { timeout: 5000 }, async () => {
  const fade = Number(JSON.parse(readFileSync(new URL("../workbench.json", import.meta.url), "utf8")).chrome["group-focus-fade"]);
  assert.ok(fade > 0 && fade < 1 && fade ** 2 >= 0.3, `group-focus-fade ${fade} keeps two levels visible`);
  const marks = () => Object.fromEntries(["card-5", "card-6"].map((id) => [id,
    { focus: groupElement(id).dataset.focus ?? null, share: groupElement(id).style.getPropertyValue("--group-focus") }]));
  const focusOf = async (id) => (await run("core.card.get", { card: id })).focus;
  arrangeNested("card-1");
  assert.deepEqual(marks(), { "card-5": { focus: "1", share: `${100 * fade}%` }, "card-6": { focus: "2", share: `${100 * fade ** 2}%` } },
    "card-1 inside card-5 inside card-6");
  assert.deepEqual([await focusOf("card-5"), await focusOf("card-6")], [1, 2]);
  await run("core.card.focus", { card: "card-3" });
  assert.deepEqual(marks(), { "card-5": { focus: null, share: "" }, "card-6": { focus: "1", share: `${100 * fade}%` } },
    "the marks follow the focus to card-3 in the draw that moves it");
  assert.deepEqual([await focusOf("card-5"), await focusOf("card-6")], [null, 1]);
  await run("core.card.focus", { card: "card-4" });
  assert.deepEqual(marks(), { "card-5": { focus: null, share: "" }, "card-6": { focus: null, share: "" } }, "card-4 stands outside every group");
  assert.deepEqual([await focusOf("card-5"), await focusOf("card-6")], [null, null]);
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

// A head holds four split buttons, each named by its result and its direction: the splits beside the card and the group splits toward
// right and bottom, which are enabled while their group succeeds and are never hidden (docs/spec/groups.md#headers).
test("a content card head shows the split and group split buttons toward each direction and the leader button pressed on its leader", { timeout: 5000 }, () => {
  arrange();
  assert.deepEqual(headTools("card-1").map((button) => button.dataset.expose),
    ["core.card.add", "core.card.split-x", "core.card.split-y", "core.card.group-x", "core.card.group-y", "core.card.leader",
      "core.card.fullscreen", "core.card.close"]);
  const button = (id, name) => cardElement(id).querySelector(`[data-expose="${name}"]`);
  for (const [name, menu, title] of [["core.card.group-x", "group-x", "그룹으로 좌우 분할"], ["core.card.group-y", "group-y", "그룹으로 상하 분할"]]) {
    assert.equal(button("card-1", name).hidden, false, `${name} is shown`);
    assert.equal(button("card-1", name).disabled, false, `${name} is enabled while its group succeeds`);
    assert.equal(button("card-1", name).title, title);
    assert.equal(button("card-1", name).dataset.command, "core.card.menu");
    assert.deepEqual(JSON.parse(button("card-1", name).dataset.params), { card: "card-1", menu });
  }
  assert.equal(button("card-1", "core.card.leader").dataset.command, "core.group.leader");
  assert.deepEqual(["card-1", "card-2", "card-3"].map((id) => [button(id, "core.card.leader").hidden, button(id, "core.card.leader").getAttribute("aria-pressed")]),
    [[false, "true"], [false, "false"], [false, "false"]], "card-1 leads its level, card-2 does not, and card-4 leads the root level of card-3");
});

// Each group split menu groups the card toward its own side, whatever the shape of the card, and each press sends a new request, so a
// second press groups the card again (docs/spec/groups.md#headers, docs/spec/groups.md#idempotency).
test("core.card.menu group-x and group-y group the card with a new card toward right and toward bottom", { timeout: 5000 }, async () => {
  for (const [menu, side] of [["group-x", "right"], ["group-y", "bottom"]]) {
    arrange();
    await run("core.card.menu", { card: "card-3", menu });
    assert.equal(plane.pickerState().open, true);
    await pick(PLAIN);
    const tree = plane.currentTree();
    const made = tree.parentOf("card-3");
    assert.ok(made, `${menu}: card-3 is a member of a new group card`);
    assert.equal(made.members.length, 2);
    const born = made.members.find((member) => member !== "card-3");
    assert.equal(tree.neighbour("card-3", side), born, `${menu}: the new card stands toward ${side}`);
  }
  // card-3 is drawn higher than wide, so it has the room for a second group toward bottom.
  const first = plane.currentTree().parentOf("card-3").card;
  await run("core.card.menu", { card: "card-3", menu: "group-y" });
  await pick(PLAIN);
  assert.notEqual(plane.currentTree().parentOf("card-3").card, first, "a second press groups card-3 again");
});

// A group header holds no add button, so its add menu is refused (docs/spec/groups.md#headers).
test("core.card.menu on a group card opens the menu of its header, whose items act on the group card", { timeout: 5000 }, async () => {
  arrange();
  await assert.rejects(run("core.card.menu", { card: "card-4", menu: "add" }),
    (error) => error.message === "card card-4 is a group; a group header has no add menu");
  assert.equal(plane.pickerState().open, false, "no menu opens for the add of a group card");
  await run("core.card.menu", { card: "card-4", menu: "group-y" });
  await pick(PLAIN);
  const wrapped = plane.currentTree().parentOf("card-4");
  assert.ok(wrapped && wrapped.members.length === 2, "the group split of the group card wraps it with a new card in a new group");
  assert.equal(plane.currentTree().neighbour("card-4", "bottom"), wrapped.members.find((member) => typeof member === "string"),
    "the new content card stands below the group card");
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
  const reported = async () => {
    const { cards, groups, fullscreen } = await status("core.grid");
    return new Map([...cards, ...groups].map(({ id, x, y, w, h }) => [id, { x, y, w, h, fullscreen: id === fullscreen }]));
  };
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

// JSDOM has no stylesheet, so a test of the header fit gives a head the padding and the gap of card-head-pad and card-head-gap and gives ≡
// and ⋯ the width of card-button, as app.css does.
function styleHead(row) {
  Object.assign(row.style, { paddingLeft: "4px", paddingRight: "4px", columnGap: "4px" });
  for (const button of row.querySelectorAll(".chrome__ham, .chrome__more")) button.style.width = "20px";
}

test("the leader keeps its leader mark in a head too narrow for its tools, and its tool menu does not hold it", { timeout: 5000 }, async () => {
  arrange();
  // JSDOM has no layout engine: each head is narrower than its tool row, so its tools fold into the menu.
  for (const id of ["card-1", "card-2"]) {
    const chrome = cardElement(id).querySelector(".chrome");
    Object.defineProperty(chrome, "clientWidth", { value: 120, configurable: true });
    styleHead(chrome);
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
  plane.closePicker("test end");
  // The leader item of a member that does not lead makes it the leader, as its button does.
  await run("core.card.tools", { card: "card-2" });
  await run("core.picker.pick", { index: plane.pickerState().items.findIndex((item) => item.key === "leader") });
  assert.equal(plane.currentTree().leaderOf(plane.currentTree().parentOf("card-2")), "card-2", "the leader item does not make card-2 the leader");
});

// A group header folds its buttons by the header fit of a card head, with its name in the place of the tabs: too narrow for its buttons,
// it keeps the fullscreen toggle, the leader mark on the leader and ⋯, whose tool menu holds the other buttons and runs each as its
// button does (docs/spec/groups.md#headers, docs/spec/cases/layout/head.json).
test("a group header too narrow for its buttons folds them into its tool menu, which runs them", { timeout: 5000 }, async () => {
  arrange();
  const head = groupElement("card-4").querySelector(".group__head");
  // JSDOM has no layout engine: the name grows over the room of the header, 1000 wide, unless the fit holds its growth to measure its
  // text, 40 wide.
  const name = head.querySelector(".group__name");
  Object.defineProperty(name, "scrollWidth", { value: 1000, configurable: true });
  name.getBoundingClientRect = () => ({ x: 0, y: 0, width: head.dataset.measure === undefined ? 1000 : 40, height: 20 });
  Object.defineProperty(head, "clientWidth", { value: 400, configurable: true });
  styleHead(head);
  head.querySelector(".chrome__acts").getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24 });
  plane.settle();
  assert.equal(head.dataset.tools, "bar", "a group header with room for its name and its buttons shows its buttons in one row");
  assert.equal(head.dataset.measure, undefined, "the fit leaves the name free to grow");
  Object.defineProperty(head, "clientWidth", { value: 120, configurable: true });
  head.querySelector(".chrome__acts").getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24 });
  plane.settle();
  assert.equal(head.dataset.tools, "menu", "the narrow header of card-4 is not folded");
  assert.equal(head.dataset.mark, "leader", "the header of the leader card-4 does not keep its leader mark");
  const more = head.querySelector(".chrome__more");
  assert.ok(more, "the group header has no tool menu button");
  assert.equal(more.dataset.expose, "core.card.tools");
  assert.equal(more.dataset.command, "core.card.tools");
  assert.deepEqual(JSON.parse(more.dataset.params), { card: "card-4" });
  await run("core.card.tools", { card: "card-4" });
  assert.deepEqual(plane.pickerState().items.map((item) => item.key), ["x", "y", "gx", "gy", "group-menu"],
    "the tool menu holds the folded buttons without the fullscreen toggle and the leader mark");
  await run("core.picker.pick", { index: 4 });
  assert.deepEqual(plane.pickerState().items.map((item) => item.key), ["close", "dissolve"], "the close item opens the close menu of the group");
  plane.closePicker("test end");
  await run("core.card.tools", { card: "card-4" });
  await run("core.picker.pick", { index: 3 });
  await pick(PLAIN);
  assert.equal(plane.currentTree().neighbour("card-4", "bottom")?.startsWith("card-"), true, "the group split item groups card-4 toward bottom");
});

// A head too narrow for its tools keeps the fullscreen toggle beside ⋯, and the tool menu does not hold it
// (docs/spec/example-model.md#card-tools).
test("a narrow head keeps the fullscreen toggle beside its tool menu, and the menu does not hold it", { timeout: 5000 }, async () => {
  arrange();
  const chrome = cardElement("card-3").querySelector(".chrome");
  Object.defineProperty(chrome, "clientWidth", { value: 120, configurable: true });
  styleHead(chrome);
  chrome.querySelector(".chrome__acts").getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24 });
  plane.settle();
  assert.equal(chrome.dataset.tools, "menu", "the head of card-3 is not folded");
  assert.equal(plane.cardActs("card-3").fullscreen.hidden, false, "the narrow head of card-3 hides its fullscreen toggle");
  await run("core.card.tools", { card: "card-3" });
  assert.equal(plane.pickerState().items.some((item) => item.key === "fullscreen"), false, "the tool menu of card-3 holds the fullscreen toggle");
  plane.closePicker("test end");
});

// A head at the minimum width of a card keeps a part of its active tab at least tab-grab-w wide and folds the fullscreen toggle into
// the tool menu before the tab, so only ⋯ stands after the tab (docs/spec/example-model.md#card-tabs).
test("a head at the minimum width of a card keeps a part of its tab and folds the fullscreen toggle into its tool menu", { timeout: 5000 }, async () => {
  arrange();
  const chrome = cardElement("card-3").querySelector(".chrome");
  // JSDOM has no layout engine: the head is the minimum card width 96 less its two borders, its tab is 120 wide and each tool is 20 wide.
  Object.defineProperty(chrome, "clientWidth", { value: 94, configurable: true });
  styleHead(chrome);
  const rect = (width) => () => ({ x: 0, y: 0, width, height: 24, top: 0, left: 0, right: width, bottom: 24 });
  chrome.querySelector(".chrome__acts").getBoundingClientRect = rect(200);
  for (const tab of chrome.querySelectorAll(".tab")) tab.getBoundingClientRect = rect(120);
  for (const act of chrome.querySelectorAll(".chrome__act")) act.getBoundingClientRect = rect(20);
  plane.settle();
  assert.equal(chrome.dataset.fit, "one", "the head of card-3 at the minimum width shows no tab");
  assert.equal(chrome.dataset.tools, "all", "the head of card-3 at the minimum width keeps tools beside its tool menu");
  assert.equal(plane.cardActs("card-3").fullscreen.hidden, true, "the head of card-3 at the minimum width shows its fullscreen toggle");
  await run("core.card.tools", { card: "card-3" });
  assert.equal(plane.pickerState().items.some((item) => item.key === "fullscreen"), true, "the tool menu of card-3 does not hold the fullscreen toggle");
  plane.closePicker("test end");
});
