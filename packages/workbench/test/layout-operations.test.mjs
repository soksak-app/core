// The layout operations core.layout.open, core.layout.select and core.layout.close of the main page and the tree of the layout of the
// window description (docs/spec/cli.md#acting-on-a-layout, docs/spec/exposure.md#window-snapshot). The workbench of the mygo host runs
// the same cases (docs/spec/host-contract.md#workbench-cases). Each case applies its operation twice through the registry of the page and
// compares the layout of the description and the result of both applications. The page runs without a host, as in the browser runtime.
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

// The project of the window has the shown space and a space that is not active, which holds the card other and the tab tab-ooooo1.
const view = (id, plugin, params) => ({ id, plugin, title: id, origin: { directory: null }, ...(params === undefined ? {} : { params }) });
const OTHER_SPACE = { id: "spc-bbbbbb", title: "SPACE2", layout: { focusedId: "other", named: 0, windowSidebars: {}, sidebars: {}, state: {
  xs: [0, 1], ys: [0, 1], cards: [{ id: "other", c0: 0, c1: 1, r0: 0, r1: 1, data: { tabs: [view("tab-ooooo1", PLAIN)], activeId: "tab-ooooo1" } }] } } };
begin({ common: {}, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, state: {
    xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, data: { tabs: [view("tab-aaaaa1", PLAIN)], activeId: "tab-aaaaa1" } }] } } },
  OTHER_SPACE,
], activeSpaceId: "spc-aaaaaa", named: 2 }] });

/** Shows the layout of cards ({id, c0, c1, r0, r1, tabs, active}) over the lines xs and ys with the card focused in the shown space. */
function arrange(xs, ys, cards, focused) {
  plane.closePicker("fixture reset");
  if (plane.currentGrid()) for (const card of plane.currentGrid().cards) for (const tab of plane.tabsOf(card)) reports.forgetTab(tab.id);
  plane.adopt({ focusedId: focused, named: 0, windowSidebars: {}, sidebars: {}, state: { xs, ys, cards: cards.map(({ tabs, active, ...card }) =>
    ({ ...card, data: { tabs, activeId: active ?? tabs[0].id } })) } }, "spc-aaaaaa");
}
const single = (tabs) => arrange([0, 1], [0, 1], [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs }], "main");
const run = (name, params) => registry.run(name, params);
const layout = () => plane.layoutDescription();
/** Applies the operation twice and returns the result of the first after it checks that the second answers and leaves the same. */
async function twice(name, params) {
  const first = await run(name, params);
  const after = layout();
  const second = await run(name, params);
  assert.deepEqual(second, first, `the second ${name} answered another result`);
  assert.deepEqual(layout(), after, `the second ${name} changed the layout`);
  return first;
}
const cardNode = (root, id) => {
  if (root.card === id) return root;
  for (const child of root.children ?? []) {
    const found = cardNode(child, id);
    if (found) return found;
  }
  return null;
};
const cardIds = (root) => (root.card ? [root.card] : root.children.flatMap(cardIds));
const refuses = (promise, text) => assert.rejects(promise, (error) => error.message === text, `does not fail with ${text}`);

// contract: layout.open.adds-a-tab-once
test("core.layout.open applied twice adds one tab with its params, selected in its focused card", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN)]);
  const result = await twice("core.layout.open", { card: "main", plugin: SESSION, params: { name: "server" } });
  assert.equal(result.card, "main");
  const { focused, root } = layout();
  assert.equal(focused, "main");
  assert.deepEqual(root.tabs.map(({ tab, plugin, active, params }) => ({ tab, plugin, active, params })), [
    { tab: "tab-aaaaa1", plugin: PLAIN, active: false, params: null },
    { tab: result.tab, plugin: SESSION, active: true, params: { name: "server" } },
  ]);
});

// contract: layout.open.selects-the-first-equal-tab
test("core.layout.open selects the first tab whose params equal the given ones as JSON values", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", SESSION, { name: "a", size: 1, flags: { x: 1, y: 2 } }), view("tab-aaaaa2", SESSION, { flags: { y: 2, x: 1 }, size: 1.0, name: "a" }),
    view("tab-aaaaa3", SESSION), view("tab-aaaaa4", PLAIN)]);
  plane.selectTab("tab-aaaaa4");
  assert.deepEqual(await twice("core.layout.open", { card: "main", plugin: SESSION, params: { size: 1, flags: { y: 2, x: 1 }, name: "a" } }),
    { card: "main", tab: "tab-aaaaa1" });
  assert.equal(layout().root.tabs.length, 4);
  assert.equal(layout().root.tabs.find(({ active }) => active).tab, "tab-aaaaa1");
  // An omitted params equals null, the params of a tab stored without them.
  assert.deepEqual(await twice("core.layout.open", { card: "main", plugin: SESSION }), { card: "main", tab: "tab-aaaaa3" });
  // params that differ in a value add a tab.
  const added = await twice("core.layout.open", { card: "main", plugin: SESSION, params: { name: "a", size: 2, flags: { x: 1, y: 2 } } });
  assert.equal(added.card, "main");
  assert.deepEqual(layout().root.tabs.map(({ tab }) => tab), ["tab-aaaaa1", "tab-aaaaa2", "tab-aaaaa3", "tab-aaaaa4", added.tab]);
});

const SIDES = { left: { direction: "row", first: true }, right: { direction: "row", first: false },
  top: { direction: "column", first: true }, bottom: { direction: "column", first: false } };

// contract: layout.open.splits-once
test("core.layout.open with a side applied twice splits the card once toward the side", { timeout: 5000 }, async () => {
  for (const [side, { direction, first }] of Object.entries(SIDES)) {
    single([view("tab-aaaaa1", PLAIN)]);
    const result = await twice("core.layout.open", { card: "main", side, plugin: SESSION });
    assert.notEqual(result.card, "main", side);
    const { root, focused } = layout();
    assert.equal(focused, result.card, side);
    assert.equal(root.direction, direction, side);
    assert.deepEqual(root.children.map(({ card, size }) => ({ card, size })),
      first ? [{ card: result.card, size: 0.5 }, { card: "main", size: 0.5 }] : [{ card: "main", size: 0.5 }, { card: result.card, size: 0.5 }], side);
    assert.deepEqual(cardNode(root, result.card).tabs.map(({ tab, plugin, active }) => ({ tab, plugin, active })),
      [{ tab: result.tab, plugin: SESSION, active: true }], side);
  }
  // A card whose parent split has the other direction: the right card of a row splits toward the bottom.
  arrange([0, 0.5, 1], [0, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaa1", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", PLAIN)] }], "a");
  const below = await twice("core.layout.open", { card: "b", side: "bottom", plugin: SESSION });
  assert.deepEqual(layout().root.children.map((node) => node.card ?? node.children.map(({ card, size }) => ({ card, size }))),
    ["a", [{ card: "b", size: 0.5 }, { card: below.card, size: 0.5 }]]);
  // A split that makes a line cross the whole window changes the tree from a column of a row and a card to a row of two columns.
  arrange([0, 0.5, 1], [0, 0.5, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaa1", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", PLAIN)] },
    { id: "c", c0: 0, c1: 2, r0: 1, r1: 2, tabs: [view("tab-aaaaa3", PLAIN)] }], "c");
  assert.equal(layout().root.direction, "column");
  const crossing = await twice("core.layout.open", { card: "c", side: "right", plugin: SESSION });
  const { root } = layout();
  assert.equal(root.direction, "row");
  assert.deepEqual(root.children.map((node) => node.children.map(({ card }) => card)), [["a", "c"], ["b", crossing.card]]);
});

// contract: layout.open.split-beside-another-neighbour
test("core.layout.open splits beside a neighbour without the tab, and the new card becomes the neighbour", { timeout: 5000 }, async () => {
  arrange([0, 0.5, 1], [0, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaa1", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", PLAIN)] }], "a");
  const made = await twice("core.layout.open", { card: "a", side: "right", plugin: SESSION });
  assert.ok(!["a", "b"].includes(made.card));
  assert.deepEqual(layout().root.children.map(({ card }) => card), ["a", made.card, "b"]);
  // A card on that side that does not span the same two lines is no neighbour: b spans only the top row of a.
  arrange([0, 0.5, 1], [0, 0.5, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 2, tabs: [view("tab-aaaaa1", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", SESSION)] },
    { id: "c", c0: 1, c1: 2, r0: 1, r1: 2, tabs: [view("tab-aaaaa3", PLAIN)] }], "a");
  const split = await twice("core.layout.open", { card: "a", side: "right", plugin: SESSION });
  assert.ok(!["a", "b", "c"].includes(split.card));
  assert.deepEqual(cardIds(layout().root), ["a", split.card, "b", "c"]);
});

// contract: layout.open.path-chooses-the-plugin
test("core.layout.open with a path opens the plugin of its extension with the path in normal form", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN)]);
  const opened = await twice("core.layout.open", { card: "main", path: "docs/aaa.html" });
  assert.deepEqual(layout().root.tabs.find(({ tab }) => tab === opened.tab), { tab: opened.tab, plugin: EDITOR, title: layout().root.tabs[1].title,
    active: true, params: { path: "docs/aaa.html" } });
  for (const path of ["./docs/aaa.html", "docs//aaa.html", "docs/./aaa.html", "docs/aaa.html/"]) {
    assert.deepEqual(await run("core.layout.open", { card: "main", path }), opened, path);
  }
  // The name in the decomposed Unicode form names the tab of the composed form.
  const composed = await run("core.layout.open", { card: "main", path: "문서.html" });
  assert.deepEqual(await run("core.layout.open", { card: "main", path: "문서.html".normalize("NFD") }), composed);
  assert.deepEqual(layout().root.tabs.find(({ tab }) => tab === composed.tab).params, { path: "문서.html".normalize("NFC") });
  const before = layout();
  await refuses(run("core.layout.open", { card: "main", path: "docs/aaa.rs" }), "no plugin opens docs/aaa.rs");
  assert.deepEqual(layout(), before);
});

// contract: layout.open.concurrent-applications-add-one-tab
test("two applications of core.layout.open sent at once add one tab and answer the same", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN)]);
  const params = { card: "main", plugin: SESSION, params: { name: "server" } };
  const [first, second] = await Promise.all([run("core.layout.open", params), run("core.layout.open", params)]);
  assert.deepEqual(second, first);
  assert.equal(layout().root.tabs.length, 2);
  const [left, right] = await Promise.all([run("core.layout.open", { card: "main", side: "right", plugin: SESSION }),
    run("core.layout.open", { card: "main", side: "right", plugin: SESSION })]);
  assert.deepEqual(right, left);
  assert.deepEqual(cardIds(layout().root), ["main", left.card]);
});

// contract: layout.open.refusal-changes-nothing
test("a refused core.layout.open fails with its error and leaves the layout", { timeout: 5000 }, async () => {
  arrange([0, 0.5, 1], [0, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaa1", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", PLAIN)] }], "a");
  const before = layout();
  const refusals = [
    [{ card: "nothing", plugin: SESSION }, `card nothing is not in the layout of window ${WINDOW}`],
    [{ card: "other", plugin: SESSION }, "card other is in space spc-bbbbbb, which is not active"],
    [{ card: "a", plugin: "fixture-missing" }, "unknown plugin fixture-missing"],
    [{ card: "a", plugin: SESSION, params: { name: 5 } }, `params do not match ${SESSION} surface.params`],
    [{ card: "a", plugin: PLAIN, params: { name: "x" } }, `plugin ${PLAIN} declares no tab params`],
    [{ card: "a", plugin: EDITOR, path: "aaa.html" }, "core.layout.open takes plugin or path, not both"],
    [{ card: "a" }, "core.layout.open needs plugin or path"],
    [{ card: "a", path: "aaa.html", params: { path: "aaa.html" } }, "core.layout.open takes params only with plugin"],
    [{ card: "a", path: "../aaa.html" }, "path must be relative to the project root: ../aaa.html"],
  ];
  for (const [params, text] of refusals) {
    await refuses(run("core.layout.open", params), text);
    assert.deepEqual(layout(), before, text);
  }
  await refuses(run("core.layout.open", { card: "a", side: "middle", plugin: SESSION }), "invalid params for core.layout.open");
  assert.deepEqual(layout(), before);
  // A card narrower than two cards of the minimum size cannot split across.
  arrange([0, 0.97, 1], [0, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaa1", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", PLAIN)] }], "a");
  const narrow = layout();
  await refuses(run("core.layout.open", { card: "b", side: "right", plugin: SESSION }), "card b cannot split toward right");
  assert.deepEqual(layout(), narrow);
  // A card of a fullscreen arrangement does not change the layout.
  plane.toggleCardFullscreen("a");
  await refuses(run("core.layout.open", { card: "a", plugin: SESSION }),
    "card a: the layout does not change while card a is fullscreen; restore the arrangement first");
  plane.toggleCardFullscreen("a");
  assert.deepEqual(layout(), narrow);
});

// contract: layout.current.resolves-at-each-application
test("current names the focused card and the active tab of the focused card at each application", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN)]);
  const first = await run("core.layout.open", { card: "current", side: "right", plugin: SESSION });
  const second = await run("core.layout.open", { card: "current", side: "right", plugin: SESSION });
  assert.notEqual(second.card, first.card);
  assert.deepEqual(cardIds(layout().root), ["main", first.card, second.card]);
  assert.equal(layout().focused, second.card);
  assert.deepEqual(await run("core.layout.select", { tab: "current" }), second);
  assert.deepEqual(await run("core.layout.close", { tab: "current" }), { closed: true });
  assert.deepEqual(cardIds(layout().root), ["main", first.card]);
});

// contract: layout.select.twice-is-the-same
test("core.layout.select applied twice makes the tab active in its focused card and answers the same", { timeout: 5000 }, async () => {
  arrange([0, 0.5, 1], [0, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaa1", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", PLAIN), view("tab-aaaaa3", SESSION)] }], "a");
  assert.deepEqual(await twice("core.layout.select", { tab: "tab-aaaaa3" }), { card: "b", tab: "tab-aaaaa3" });
  assert.equal(layout().focused, "b");
  assert.deepEqual(cardNode(layout().root, "b").tabs.map(({ active }) => active), [false, true]);
  await refuses(run("core.layout.select", { tab: "tab-ooooo1" }), "tab tab-ooooo1 is in space spc-bbbbbb, which is not active");
  await refuses(run("core.layout.select", { tab: "tab-zzzzzz" }), `tab tab-zzzzzz is not in the layout of window ${WINDOW}`);
});

// contract: layout.close.repeated-close-answers-closed
test("core.layout.close closes the tab once, answers closed again, and no new tab takes its identifier", { timeout: 5000 }, async () => {
  arrange([0, 0.5, 1], [0, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaaa", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", PLAIN), view("tab-aaaaa3", PLAIN)] }], "b");
  assert.deepEqual(await twice("core.layout.close", { tab: "tab-aaaaa3" }), { closed: true });
  assert.deepEqual(cardNode(layout().root, "b").tabs.map(({ tab }) => tab), ["tab-aaaaa2"]);
  // A card that loses its last tab closes.
  assert.deepEqual(await twice("core.layout.close", { tab: "tab-aaaaaa" }), { closed: true });
  assert.deepEqual(cardIds(layout().root), ["b"]);
  // The identifier of the closed tab is taken: a source that draws its bytes first gives the next tab another identifier.
  let draws = 0;
  const made = plane.fresh((bytes) => bytes.fill(draws++ === 0 ? 0 : 1));
  assert.deepEqual(made.state.cards.flatMap((card) => card.data?.tabs ?? []).map(({ id }) => id), ["tab-bbbbbb"]);
  await refuses(run("core.layout.close", { tab: "tab-zzzzzz" }), `tab tab-zzzzzz is not in the layout of window ${WINDOW}`);
});

// contract: layout.close.unsaved-tab-answers-at-once
test("core.layout.close of a modified tab opens one question and answers closed false at once", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN), view("tab-aaaaa2", SESSION)]);
  reports.reportModified("tab-aaaaa2", true);
  let changes = 0;
  plane.onPicker(() => { changes++; });
  try {
    assert.deepEqual(await run("core.layout.close", { tab: "tab-aaaaa2" }), { closed: false });
    const question = plane.pickerState();
    assert.equal(question.open, true);
    assert.match(question.title, /저장하지 않은 변경/);
    const opened = changes;
    assert.deepEqual(await run("core.layout.close", { tab: "tab-aaaaa2" }), { closed: false });
    assert.equal(changes, opened, "the second close opened another question");
    assert.deepEqual(plane.pickerState(), question);
    assert.deepEqual(layout().root.tabs.map(({ tab }) => tab), ["tab-aaaaa1", "tab-aaaaa2"]);
    // The person answers: the tab closes without saving.
    plane.pickItem(question.items.findIndex(({ name }) => name === "저장하지 않고 닫기"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(layout().root.tabs.map(({ tab }) => tab), ["tab-aaaaa1"]);
    assert.deepEqual(await run("core.layout.close", { tab: "tab-aaaaa2" }), { closed: true });
  } finally {
    reports.forgetTab("tab-aaaaa2");
    // The core statuses follow the picker again, as the core exposure installed them.
    plane.onPicker(coreChanged);
  }
});

// A split that the layout refuses leaves the layout and the tab-name counter as they were: the tab of the new card is made only for a
// split that the layout takes.
test("a refused split of a card leaves the number of the next tab name unchanged", { timeout: 5000 }, async () => {
  arrange([0, 0.97, 1], [0, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaa1", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", PLAIN)] }], "a");
  const before = layout();
  assert.throws(() => plane.splitCard("b", "right", SESSION), { message: "card b cannot split toward right" });
  assert.deepEqual(layout(), before);
  const { tab } = await run("core.layout.open", { card: "a", plugin: SESSION });
  assert.equal(cardNode(layout().root, "a").tabs.find((item) => item.tab === tab).title, "탭 1");
});

// The layout stores the name of a new tab without the mark of its plugin, which the strip draws before the name
// (docs/spec/example-model.md#card-tabs), so core.grid reports the name alone as the title of the tab.
test("a new tab stores its name without the mark of its plugin, and the strip draws the mark before the name", { timeout: 5000 }, async () => {
  arrange([0, 1], [0, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaa1", PLAIN)] }], "a");
  const { tab } = await run("core.layout.open", { card: "a", plugin: SESSION });
  const stored = cardNode(layout().root, "a").tabs.find((item) => item.tab === tab);
  assert.match(stored.title, /^탭 \d+$/, "the stored title is the name alone");
  assert.equal(reports.tabButtonData({ id: tab, plugin: SESSION, title: stored.title }).name, `f ${stored.title}`, "the strip draws the mark before the name");
});

// The close of a modified tab of a fullscreen card closes the card with its last tab after the answer, so the answer restores the
// arrangement before the tab closes: a fullscreen presentation of a card that left the layout fails the next draw.
test("the answer to the question about a modified tab of a fullscreen card restores the arrangement before the tab closes", { timeout: 5000 }, async () => {
  arrange([0, 0.5, 1], [0, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaa1", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", SESSION)] }], "b");
  reports.reportModified("tab-aaaaa2", true);
  try {
    plane.toggleCardFullscreen("b");
    assert.equal(plane.fullscreenCard(), "b");
    assert.deepEqual(await run("core.layout.close", { tab: "tab-aaaaa2" }), { closed: false });
    const question = plane.pickerState();
    plane.pickItem(question.items.findIndex(({ name }) => name === "저장하지 않고 닫기"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cardIds(layout().root), ["a"]);
    assert.equal(plane.fullscreenCard(), null);
    // The next draw presents the arrangement of the cards that remain.
    plane.settle();
    assert.equal(plane.fullscreenCard(), null);
  } finally {
    reports.forgetTab("tab-aaaaa2");
  }
});

// The arrangements with a place card of a window sidebar run in layout-tree-sidebar.test.mjs, whose window declares that sidebar.
// contract: layout.tree.one-tree-per-arrangement
test("the lines and cards of each arrangement of tree.json without a window sidebar give its root", { timeout: 5000 }, () => {
  const { cases } = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/layout/tree.json", import.meta.url), "utf8"));
  const close = (actual, expected, where) => {
    if (typeof expected === "number") {
      assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${where}: ${actual} is not ${expected}`);
      return;
    }
    if (typeof expected !== "object") {
      assert.equal(actual, expected, where);
      return;
    }
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), where);
    for (const key of Object.keys(expected)) {
      if (key === "children") expected.children.forEach((child, i) => close(actual.children[i], child, `${where}/${i}`));
      else close(actual[key], expected[key], `${where}.${key}`);
    }
  };
  const sidebar = (id) => ["left", "right", "top", "bottom"].includes(id);
  const plain = cases.filter(({ layout: { cards } }) => !cards.some(({ id }) => sidebar(id)));
  assert.ok(plain.length >= 3, "tree.json holds fewer than three arrangements without a window sidebar");
  for (const { name, layout: { xs, ys, cards }, root } of plain) {
    arrange(xs, ys, cards.map((card, i) => ({ ...card, tabs: [view(`tab-tree${String(i).padStart(2, "0")}`, PLAIN)] })), cards[0].id);
    assert.deepEqual(plane.currentGrid().cards.map(({ id }) => id), cards.map(({ id }) => id), `${name}: the plane did not keep the cards of the case`);
    const strip = (node) => (node.card ? { card: node.card, size: node.size }
      : { direction: node.direction, size: node.size, children: node.children.map(strip) });
    close(strip(layout().root), root, name);
    // Each card of the tree has its frame and its tabs.
    const leaves = (node) => (node.card ? [node] : node.children.flatMap(leaves));
    for (const leaf of leaves(layout().root)) {
      assert.deepEqual(Object.keys(leaf.frame), ["x", "y", "width", "height"], name);
      assert.equal(leaf.tabs.length, 1, name);
    }
  }
});

// contract: layout.surface-window.answers-the-space
test("surface.window answers the space whose layout holds the tab, null for a tab of no space and refuses a missing surface", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN)]);
  const ask = (params) => registry.handle({ id: 1, method: "surface.window", params });
  assert.deepEqual(await ask({ surface: "tab-aaaaa1" }), { result: { space: "spc-aaaaaa" } });
  assert.deepEqual(await ask({ surface: "tab-ooooo1" }), { result: { space: "spc-bbbbbb" } });
  assert.deepEqual(await ask({ surface: "tab-zzzzz9" }), { result: null });
  for (const params of [{}, { surface: "" }, { surface: 7 }]) {
    assert.deepEqual(await ask(params), { error: { code: -32602, message: "surface must be a non-empty string" } }, JSON.stringify(params));
  }
});

// contract: layout.surface-window.answers-the-space
test("surface.window answers the space null for a section surface that a sidebar of the window draws, and null once it is released", { timeout: 5000 }, async () => {
  const { registerPlugin, registerSection } = await import("../registry.js");
  const { clearSet, drawSet } = await import("../sidebar-sections.js");
  const composition = { kind: "view", page: "ui/tree.html" };
  registerPlugin({ id: "probe", name: "Probe", mark: "p", svg: "<path/>", ink: null, background: null, drop: null, surface: () => null });
  registerSection({ id: "probe.tree", name: "Tree", plugin: "probe", composition, height: "fill",
    surface: (surfaceId, start) => ({ composition, surfaceId, pluginId: "probe", declarations: {}, sidecars: [], diagnostics: null, unload: false,
      params: null, section: start }) });
  single([view("tab-aaaaa1", PLAIN)]);
  const ask = (params) => registry.handle({ id: 1, method: "surface.window", params });
  const surface = "spc-aaaaaa/main:left/probe.tree";
  const container = document.createElement("div");
  document.getElementById("plane").append(container);
  try {
    drawSet(container, "main:left", { id: "probe.list", title: "List", layout: "list", sections: ["probe.tree"] },
      { space: "spc-aaaaaa", card: "main", surface: "tab-aaaaa1", orientation: "vertical" });
    assert.deepEqual(await ask({ surface }), { result: { space: null } });
  } finally {
    clearSet(container);
    container.remove();
  }
  assert.deepEqual(await ask({ surface }), { result: null });
});

// The part of the main page in a window snapshot takes its layout and its plugins from the window (snapshotParts of core-exposure.js).
// contract: endpoint.exposure-snapshot.groups-the-window
test("exposure.snapshot holds the layout of the description as a tree of splits and cards and the plugins with their surface params and opens", { timeout: 5000 }, async () => {
  arrange([0, 0.5, 1], [0, 1], [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [view("tab-aaaaa1", PLAIN)] },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [view("tab-aaaaa2", EDITOR, { path: "a.html" })] }], "b");
  const { result } = await registry.handle({ id: 1, method: "exposure.snapshot", params: {} });
  assert.deepEqual(result.layout, layout());
  const { space, focused, root } = result.layout;
  assert.deepEqual({ space, focused, direction: root.direction, cards: cardIds(root) }, { space: "spc-aaaaaa", focused: "b", direction: "row", cards: ["a", "b"] });
  for (const card of ["a", "b"]) assert.deepEqual(Object.keys(cardNode(root, card).frame), ["x", "y", "width", "height"], card);
  assert.deepEqual(cardNode(root, "b").tabs.map(({ tab, plugin, active, params }) => ({ tab, plugin, active, params })),
    [{ tab: "tab-aaaaa2", plugin: EDITOR, active: true, params: { path: "a.html" } }]);
  const description = "검사용 표면.";
  assert.deepEqual(result.plugins, [
    { plugin: SESSION, name: SESSION, description, surface: { params: { type: "object", properties: { name: { type: "string" }, size: { type: "number" },
      flags: { type: "object" } } }, opens: [] } },
    { plugin: EDITOR, name: EDITOR, description, surface: { params: { type: "object", properties: { path: { type: "string" } } }, opens: ["html"] } },
    { plugin: PLAIN, name: PLAIN, description, surface: { params: null, opens: [] } },
  ]);
});
