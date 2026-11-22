// The layout operations core.layout.open, core.layout.select and core.layout.close of the main page and the tree of the layout of the
// window description (docs/spec/cli.md#acting-on-a-layout, docs/spec/exposure.md#window-snapshot). The workbench of the mygo host runs
// the same cases (docs/spec/host-contract.md#workbench-cases). Each case applies its operation twice through the registry of the page and
// compares the layout of the description and the result of both applications. The page runs without a host, as in the browser runtime.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";
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

// The project of the window has the shown space and a space that is not active, which holds the card other and the tab tab-ooooo1.
const view = (id, plugin, params) => ({ id, plugin, title: id, origin: { directory: null }, role: null, ...(params === undefined ? {} : { params }) });
const OTHER_SPACE = { id: "spc-bbbbbb", title: "SPACE2", layout: { focusedId: "other", named: 0, windowSidebars: {}, sidebars: {}, leader: "other", lastCard: 1, state: {
  root: { card: "other", data: { tabs: [view("tab-ooooo1", PLAIN)], activeId: "tab-ooooo1" } } } } };
begin({ common: {}, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main", lastCard: 1, state: {
    root: { card: "main", data: { tabs: [view("tab-aaaaa1", PLAIN)], activeId: "tab-aaaaa1" } } } } },
  OTHER_SPACE,
], activeSpaceId: "spc-aaaaaa", named: 2 }] });

/** The members of a stored layout without groups over state: the first card in reading order leads, and lastCard is the largest card number or 1. */
const emptyTree = (state) => {
  const cards = new Soksak(state).cards;
  return {
    leader: [...cards].sort((a, b) => (a.r0 - b.r0) || (a.c0 - b.c0))[0].id,
    lastCard: Math.max(1, ...cards.map(({ id }) => Number(/^card-(\d+)$/.exec(id)?.[1] ?? 0))),
  };
};

/** The tree root with each card node {card, tabs, active} given the card data of its tabs. */
const withData = (node) => {
  if (node.cut !== undefined) return { ...node, kids: node.kids.map((kid) => ({ ...kid, node: withData(kid.node) })) };
  const { tabs, active, ...card } = node;
  return { ...card, data: { tabs, activeId: active ?? tabs[0].id } };
};

/** Shows the layout of the tree root, whose card nodes are {card, tabs, active}, with the card focused in the shown space. */
function arrange(root, focused) {
  plane.closePicker("fixture reset");
  if (plane.currentGrid()) for (const card of plane.currentGrid().cards) for (const tab of plane.tabsOf(card)) reports.forgetTab(tab.id);
  const state = { root: withData(root) };
  plane.adopt({ focusedId: focused, named: 0, windowSidebars: {}, sidebars: {}, ...emptyTree(state), state }, "spc-aaaaaa");
}
const single = (tabs) => arrange({ card: "main", tabs }, "main");
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
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
  ] }, "a");
  const below = await twice("core.layout.open", { card: "b", side: "bottom", plugin: SESSION });
  assert.deepEqual(layout().root.children.map((node) => node.card ?? node.children.map(({ card, size }) => ({ card, size }))),
    ["a", [{ card: "b", size: 0.5 }, { card: below.card, size: 0.5 }]]);
  // A split adds the new card beside the card in the cut that holds it, so the tree keeps its column of a row and a card, and the card
  // becomes a row of itself and the new card, also where the new line stands on the line of the row above it.
  arrange({ cut: "y", kids: [
    { share: 0.5, node: { cut: "x", kids: [
      { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
      { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
    ] } },
    { share: 0.5, node: { card: "c", tabs: [view("tab-aaaaa3", PLAIN)] } },
  ] }, "c");
  assert.equal(layout().root.direction, "column");
  const crossing = await twice("core.layout.open", { card: "c", side: "right", plugin: SESSION });
  const { root } = layout();
  assert.equal(root.direction, "column");
  assert.deepEqual(root.children.map((node) => [node.direction, node.children.map(({ card }) => card)]),
    [["row", ["a", "b"]], ["row", ["c", crossing.card]]]);
});

// contract: layout.open.split-beside-another-neighbour
test("core.layout.open splits beside a neighbour without the tab, and the new card becomes the neighbour", { timeout: 5000 }, async () => {
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
  ] }, "a");
  const made = await twice("core.layout.open", { card: "a", side: "right", plugin: SESSION });
  assert.ok(!["a", "b"].includes(made.card));
  assert.deepEqual(layout().root.children.map(({ card }) => card), ["a", made.card, "b"]);
  // A card on that side that does not span the same two lines is no neighbour: b spans only the top row of a.
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { cut: "y", kids: [
      { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", SESSION)] } },
      { share: 0.5, node: { card: "c", tabs: [view("tab-aaaaa3", PLAIN)] } },
    ] } },
  ] }, "a");
  const split = await twice("core.layout.open", { card: "a", side: "right", plugin: SESSION });
  assert.ok(!["a", "b", "c"].includes(split.card));
  assert.deepEqual(cardIds(layout().root), ["a", split.card, "b", "c"]);
});

// contract: layout.open.rule-of-sizes
test("core.layout.open adds a card by the rule of sizes: one more equal child of an even split, half of the card of an uneven one", { timeout: 5000 }, async () => {
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
  ] }, "a");
  const even = await twice("core.layout.open", { card: "a", side: "right", plugin: SESSION });
  const sizes = () => layout().root.children.map(({ card, size }) => [card, Math.round(size * 1e6) / 1e6]);
  assert.deepEqual(sizes(), [["a", 0.333333], [even.card, 0.333333], ["b", 0.333333]]);
  arrange({ cut: "x", kids: [
    { share: 0.7, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.3, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
  ] }, "a");
  const uneven = await twice("core.layout.open", { card: "a", side: "right", plugin: SESSION });
  assert.deepEqual(sizes(), [["a", 0.35], [uneven.card, 0.35], ["b", 0.3]]);
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
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
  ] }, "a");
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
  // The registry names an unknown member and a missing member of the declaration (docs/spec/exposure.md#command-parameters).
  await refuses(run("core.layout.open", { card: "a", plugin: SESSION, zone: "left" }), "command core.layout.open: unknown parameter zone");
  await refuses(run("core.layout.move", { card: "a" }), "command core.layout.move: parameter tab is required");
  // A request with members that the declaration does not list is refused, also by a command whose members are all optional.
  await refuses(run("core.settings.set", { key: "font", value: 12 }), "command core.settings.set: unknown parameter key");
  await refuses(run("core.settings.set", { bogus: 1 }), "command core.settings.set: unknown parameter bogus");
  await refuses(run("core.layout.balance", { bogus: 1 }), "command core.layout.balance: unknown parameter bogus");
  // The role commands of a tab run through the host store (docs/spec/agent-roles.md#tab-role-state); this page runs without a
  // host, so the store refusal names the missing initialisation.
  await refuses(run("core.tab.role", { tab: "tab-aaaaaa", role: "a" }), "projects.rolePut: the projects are not initialised");
  await refuses(run("core.tab.role.confirm", { fingerprint: "0123456789abcdef" }), "core.tab.role.confirm requires the surface of its caller");
  // The role status of a tab is read with the surface of its request (docs/spec/agent-roles.md#tab-role-state).
  const statusOf = (params) => registry.handle({ id: 1, method: "status.get", params }).then((reply) => {
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  });
  await refuses(statusOf({ name: "core.tab.role" }), "status.get for core.tab.role requires a surface");
  await refuses(statusOf({ name: "core.tab.role", surface: "tab-aaaaaa" }), "projects.roleOf: the projects are not initialised");
  assert.deepEqual(layout(), before);
  // A card narrower than two cards of the minimum size cannot split across, and the refusal names the size that a half would get.
  arrange({ cut: "x", kids: [
    { share: 0.97, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.03, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
  ] }, "a");
  const narrow = layout();
  await refuses(run("core.layout.open", { card: "b", side: "right", plugin: SESSION }), "card b cannot split toward right: card b would be 24x1200, below its minimum 96x96");
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
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN), view("tab-aaaaa3", SESSION)] } },
  ] }, "a");
  assert.deepEqual(await twice("core.layout.select", { tab: "tab-aaaaa3" }), { card: "b", tab: "tab-aaaaa3" });
  assert.equal(layout().focused, "b");
  assert.deepEqual(cardNode(layout().root, "b").tabs.map(({ active }) => active), [false, true]);
  await refuses(run("core.layout.select", { tab: "tab-ooooo1" }), "tab tab-ooooo1 is in space spc-bbbbbb, which is not active");
  await refuses(run("core.layout.select", { tab: "tab-zzzzzz" }), `tab tab-zzzzzz is not in the layout of window ${WINDOW}`);
});

// contract: layout.move.into-a-card-once
test("core.layout.move applied twice moves a tab into a card once, active in its focused card, with its identifier", { timeout: 5000 }, async () => {
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN), view("tab-aaaaa2", SESSION, { name: "s" })] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa3", PLAIN)] } },
  ] }, "a");
  assert.deepEqual(await twice("core.layout.move", { tab: "tab-aaaaa2", card: "b" }), { card: "b", tab: "tab-aaaaa2" });
  const { root, focused } = layout();
  assert.equal(focused, "b");
  assert.deepEqual(cardNode(root, "a").tabs.map(({ tab }) => tab), ["tab-aaaaa1"]);
  assert.deepEqual(cardNode(root, "b").tabs.map(({ tab, active, params }) => ({ tab, active, params })),
    [{ tab: "tab-aaaaa3", active: false, params: null }, { tab: "tab-aaaaa2", active: true, params: { name: "s" } }]);
  // A tab that its card already holds is selected and moves nowhere.
  assert.deepEqual(await twice("core.layout.move", { tab: "tab-aaaaa3", card: "b" }), { card: "b", tab: "tab-aaaaa3" });
  assert.deepEqual(cardNode(layout().root, "b").tabs.map(({ tab, active }) => [tab, active]), [["tab-aaaaa3", true], ["tab-aaaaa2", false]]);
});

// contract: layout.move.beside-a-card-once
test("core.layout.move with a side applied twice puts the tab once into the neighbour toward the side, and the only tab moves its card", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN), view("tab-aaaaa2", SESSION)]);
  const moved = await twice("core.layout.move", { tab: "tab-aaaaa2", card: "main", side: "right" });
  assert.equal(moved.tab, "tab-aaaaa2");
  assert.notEqual(moved.card, "main");
  assert.deepEqual(layout().root.children.map(({ card, tabs }) => [card, tabs.map(({ tab }) => tab)]),
    [["main", ["tab-aaaaa1"]], [moved.card, ["tab-aaaaa2"]]]);
  assert.equal(layout().focused, moved.card);
  // The only tab of a card moves the card: its identifier stays, and the card stands toward the side.
  const below = await twice("core.layout.move", { tab: "tab-aaaaa1", card: moved.card, side: "bottom" });
  assert.deepEqual(below, { card: "main", tab: "tab-aaaaa1" });
  const { root } = layout();
  assert.equal(root.direction, "column");
  assert.deepEqual(root.children.map(({ card }) => card), [moved.card, "main"]);
});

// contract: layout.move.refusal-changes-nothing
test("a refused core.layout.move fails with its error and leaves the layout", { timeout: 5000 }, async () => {
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
  ] }, "a");
  const before = layout();
  for (const [params, text] of [
    [{ tab: "tab-zzzzzz", card: "b" }, `tab tab-zzzzzz is not in the layout of window ${WINDOW}`],
    [{ tab: "tab-ooooo1", card: "b" }, "tab tab-ooooo1 is in space spc-bbbbbb, which is not active"],
    [{ tab: "tab-aaaaa1", card: "nothing" }, `card nothing is not in the layout of window ${WINDOW}`],
  ]) {
    await refuses(run("core.layout.move", params), text);
    assert.deepEqual(layout(), before, text);
  }
  // The only tab of a card toward a side of its card names the vacated slot of the card and changes nothing (docs/spec/cli.md).
  assert.deepEqual(await run("core.layout.move", { tab: "tab-aaaaa1", card: "a", side: "right" }), { card: "a", tab: "tab-aaaaa1" });
  assert.deepEqual(layout(), before, "the move of the only tab of a toward its right side changed the layout");
});

// contract: layout.close.repeated-close-answers-closed
test("core.layout.close closes the tab once, answers closed again, and no new tab takes its identifier", { timeout: 5000 }, async () => {
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaaa", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN), view("tab-aaaaa3", PLAIN)] } },
  ] }, "b");
  assert.deepEqual(await twice("core.layout.close", { tab: "tab-aaaaa3" }), { closed: true });
  assert.deepEqual(cardNode(layout().root, "b").tabs.map(({ tab }) => tab), ["tab-aaaaa2"]);
  // A card that loses its last tab closes.
  assert.deepEqual(await twice("core.layout.close", { tab: "tab-aaaaaa" }), { closed: true });
  assert.deepEqual(cardIds(layout().root), ["b"]);
  // The identifier of the closed tab is taken: a source that draws its bytes first gives the next tab another identifier.
  let draws = 0;
  const made = plane.fresh((bytes) => bytes.fill(draws++ === 0 ? 0 : 1));
  assert.deepEqual(made.state.root.data.tabs.map(({ id }) => id), ["tab-bbbbbb"]);
  await refuses(run("core.layout.close", { tab: "tab-zzzzzz" }), `tab tab-zzzzzz is not in the layout of window ${WINDOW}`);
});

// contract: layout.close.keeps-other-cuts
test("a closed card gives its share to its split, and the cards of other splits keep their frames", { timeout: 5000 }, async () => {
  arrange({ cut: "y", kids: [
    { share: 0.5, node: { cut: "x", kids: [
      { share: 0.3, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
      { share: 0.7, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
    ] } },
    { share: 0.5, node: { cut: "x", kids: [
      { share: 0.6, node: { card: "c", tabs: [view("tab-aaaaa3", PLAIN)] } },
      { share: 0.4, node: { card: "d", tabs: [view("tab-aaaaa4", PLAIN)] } },
    ] } },
  ] }, "a");
  const before = layout().root;
  const top = before.children[0].frame;
  assert.deepEqual(await run("core.card.close", { card: "a" }), { closed: true });
  const after = layout().root;
  assert.deepEqual(cardNode(after, "b").frame, top);
  assert.deepEqual(["c", "d"].map((id) => cardNode(after, id).frame), ["c", "d"].map((id) => cardNode(before, id).frame));
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
  arrange({ cut: "x", kids: [
    { share: 0.97, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.03, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
  ] }, "a");
  const before = layout();
  assert.throws(() => plane.splitCard("b", "right", SESSION), { message: "card b cannot split toward right: card b would be 24x1200, below its minimum 96x96" });
  assert.deepEqual(layout(), before);
  const { tab } = await run("core.layout.open", { card: "a", plugin: SESSION });
  assert.equal(cardNode(layout().root, "a").tabs.find((item) => item.tab === tab).title, "탭 1");
});

// The layout stores the name of a new tab without the mark of its plugin, which the strip draws before the name
// (docs/spec/example-model.md#card-tabs), so core.grid reports the name alone as the title of the tab.
test("a new tab stores its name without the mark of its plugin, and the strip draws the mark before the name", { timeout: 5000 }, async () => {
  arrange({ card: "a", tabs: [view("tab-aaaaa1", PLAIN)] }, "a");
  const { tab } = await run("core.layout.open", { card: "a", plugin: SESSION });
  const stored = cardNode(layout().root, "a").tabs.find((item) => item.tab === tab);
  assert.match(stored.title, /^탭 \d+$/, "the stored title is the name alone");
  assert.equal(reports.tabButtonData({ id: tab, plugin: SESSION, title: stored.title }).name, `f ${stored.title}`, "the strip draws the mark before the name");
});

// The close of a modified tab of a fullscreen card closes the card with its last tab after the answer, so the answer restores the
// arrangement before the tab closes: a fullscreen presentation of a card that left the layout fails the next draw.
test("the answer to the question about a modified tab of a fullscreen card restores the arrangement before the tab closes", { timeout: 5000 }, async () => {
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", SESSION)] } },
  ] }, "b");
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
  const ids = (node) => (node.cut !== undefined ? node.kids.flatMap((kid) => ids(kid.node)) : [node.card]);
  const plain = cases.filter(({ layout }) => !ids(layout.root).some(sidebar));
  assert.ok(plain.length >= 3, "tree.json holds fewer than three arrangements without a window sidebar");
  for (const { name, layout: stored, root } of plain) {
    let i = 0;
    const tabbed = (node) => (node.cut !== undefined ? { ...node, kids: node.kids.map((kid) => ({ ...kid, node: tabbed(kid.node) })) }
      : { ...node, tabs: [view(`tab-tree${String(i++).padStart(2, "0")}`, PLAIN)] });
    arrange(tabbed(stored.root), ids(stored.root)[0]);
    assert.deepEqual(plane.currentGrid().cards.map(({ id }) => id).sort(), ids(stored.root).sort(), `${name}: the plane did not keep the cards of the case`);
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

// contract: layout.tree.splits-carry-frames
test("each split of the description carries the frame in window points that holds the frames of its children", { timeout: 5000 }, () => {
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { cut: "y", kids: [
      { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
      { share: 0.5, node: { card: "c", tabs: [view("tab-aaaaa3", PLAIN)] } },
    ] } },
  ] }, "a");
  const check = (node, where) => {
    if (node.card) return;
    assert.deepEqual(Object.keys(node), ["direction", "size", "frame", "children"], `${where}: the split has no frame`);
    const frames = node.children.map((child) => child.frame);
    const left = Math.min(...frames.map(({ x }) => x));
    const top = Math.min(...frames.map(({ y }) => y));
    assert.deepEqual(node.frame, { x: left, y: top, width: Math.max(...frames.map(({ x, width }) => x + width)) - left,
      height: Math.max(...frames.map(({ y, height }) => y + height)) - top }, where);
    node.children.forEach((child, i) => check(child, `${where}/${i}`));
  };
  const { root } = layout();
  assert.equal(root.direction, "row");
  assert.equal(root.children[1].direction, "column");
  check(root, "root");
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
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", EDITOR, { path: "a.html" })] } },
  ] }, "b");
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


/** The cards of a plan as [card, tab identifiers] in reading order. */
const planned = (cards) => cards.map(({ card, tabs }) => [card, tabs.map(({ tab }) => tab)]);
/** The number of cards of each row of planned cards, by their top edge. */
const rowSizes = (cards) => Object.values(Object.groupBy(cards, ({ frame }) => Math.round(frame.y))).map((row) => row.length);
const terminals = (count) => Array.from({ length: count }, () => ({ tabs: [{ plugin: SESSION }] }));

// contract: layout.plan.count-grid
test("core.layout.plan of a count answers the most even grid of feasible cards and changes nothing", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN)]);
  const before = layout();
  const plan = await run("core.layout.plan", { count: 10, plugin: SESSION });
  assert.deepEqual(layout(), before);
  assert.deepEqual([plan.feasible, plan.reason, plan.needed, plan.proposal], [true, null, null, null]);
  assert.deepEqual([plan.plane, plan.minimum], [{ width: 1600, height: 1200 }, { width: 96, height: 96 }]);
  // Of the grids of 1 to 10 rows, three rows of 4, 3 and 3 cards are nearest to a square in a plane of 1600 × 1200.
  assert.deepEqual(rowSizes(plan.cards), [4, 3, 3]);
  assert.deepEqual(planned(plan.cards), [["main", [null, "tab-aaaaa1"]], ...Array.from({ length: 9 }, () => [null, [null]])]);
  assert.deepEqual([plan.kept, plan.closed], [["tab-aaaaa1"], []]);
  // The tree is the tree of an apply: the kept tab is an entry {tab} of the first card.
  assert.deepEqual(plan.tree.children[0].children[0], { tabs: [{ plugin: SESSION, params: null }, { tab: "tab-aaaaa1" }], active: 0 });
  // The cards of a row share its height, and the cards of one row have one width.
  assert.deepEqual([...new Set(plan.cards.slice(0, 4).map(({ frame }) => Math.round(frame.width)))], [391]);
});

// contract: layout.apply.builds-once
test("core.layout.apply applied twice builds the plan once, keeps the tab of the plane and answers the same", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN)]);
  const plan = await run("core.layout.plan", { count: 10, plugin: SESSION });
  const applied = await twice("core.layout.apply", { tree: plan.tree });
  assert.deepEqual(applied.cards.map(({ frame }) => frame), plan.cards.map(({ frame }) => frame));
  assert.equal(applied.cards[0].card, "main");
  assert.ok(applied.cards.every(({ card, tabs }) => card !== null && tabs.every(({ tab }) => tab !== null)));
  const { root, focused } = layout();
  assert.equal(focused, "main");
  assert.equal(root.direction, "column");
  assert.deepEqual(root.children.map((row) => row.children.length), [4, 3, 3]);
  // The cards of a row are drawn at one width, and the rows at one height.
  for (const row of root.children) {
    assert.ok(row.children.every(({ frame }) => Math.abs(frame.width - row.children[0].frame.width) < 1e-6), JSON.stringify(row.children.map(({ frame }) => frame)));
    assert.ok(Math.abs(row.children[0].frame.height - root.children[0].children[0].frame.height) < 1e-6);
  }
  assert.deepEqual(cardNode(root, "main").tabs.map(({ tab, active }) => [tab === "tab-aaaaa1", active]), [[false, true], [true, false]]);
  // A repeated plan of the count takes the tabs that the apply made and keeps every card.
  const again = await run("core.layout.plan", { count: 10, plugin: SESSION });
  assert.deepEqual(planned(again.cards), planned(applied.cards));
  assert.deepEqual([again.kept, again.closed], [["tab-aaaaa1"], []]);
});

// contract: layout.plan.below-the-minimum
test("a plan below the minimum states the card, the plane it needs and the nearest grid, and its apply changes nothing", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN)]);
  const before = layout();
  const tree = { direction: "row", children: terminals(30) };
  const plan = await run("core.layout.plan", { tree });
  assert.equal(plan.feasible, false);
  // 30 cards of 96 points and 29 corridors of 12 points need 3228 points across.
  assert.equal(plan.reason, "card 1 of the tree would be 42 × 1200 points, below the minimum 96 × 96 points; " +
    "the tree needs a plane of 3228 × 96 points and the plane is 1600 × 1200 points");
  assert.deepEqual(plan.needed, { width: 3228, height: 96 });
  assert.deepEqual(rowSizes(plan.proposal.cards), [6, 6, 6, 6, 6]);
  assert.deepEqual(planned(plan.proposal.cards), planned(plan.cards));
  await refuses(run("core.layout.apply", { tree }), plan.reason);
  assert.deepEqual(layout(), before);
  // Of more cards than any grid fits, the proposal is the most even grid of the largest count that fits, whose last card takes the rest:
  // with cards of at least 400 points, a plane of 1600 × 1200 holds three cards across and two down.
  const grid = plane.currentGrid();
  grid.minSize = 400;
  try {
    const many = await run("core.layout.plan", { count: 8, plugin: SESSION });
    assert.equal(many.feasible, false);
    // The plan is of the grid nearest to a square, three rows of 3, 3 and 2 cards, whose rows are 392 points high.
    assert.equal(many.reason, "card 1 of the tree would be 525 × 392 points, below the minimum 400 × 400 points; " +
      "the tree needs a plane of 1224 × 1224 points and the plane is 1600 × 1200 points");
    assert.deepEqual(rowSizes(many.proposal.cards), [3, 3]);
    assert.deepEqual(many.proposal.cards.map(({ tabs }) => tabs.length), [2, 1, 1, 1, 1, 3]);
  } finally {
    grid.minSize = 96;
  }
  // A tree whose corridors of 500 points leave its cards no extent states the plane. The proposal is the most even grid of the five
  // cards: three across are (1600 - 2 × 500) / 3 = 200 points wide and two down (1200 - 500) / 2 = 350 points high, both above 96.
  grid.gap = 500;
  try {
    const wide = await run("core.layout.plan", { tree: { direction: "row", children: terminals(5) } });
    assert.deepEqual([wide.feasible, wide.reason, wide.needed, wide.cards], [false, "the cards of the tree have no extent in the plane of 1600 × 1200 points", null, []]);
    assert.deepEqual(rowSizes(wide.proposal.cards), [3, 2]);
    assert.deepEqual(wide.proposal.cards.map(({ tabs }) => tabs.length), [2, 1, 1, 1, 1]);
    assert.ok(wide.proposal.cards.every(({ frame }) => frame.width >= 96 && frame.height >= 96));
  } finally {
    grid.gap = 12;
  }
  assert.deepEqual(layout(), before);
});

// contract: layout.apply.moves-existing-tabs
test("core.layout.apply moves each existing tab with its identifier into its card and closes only what close names", { timeout: 5000 }, async () => {
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN), view("tab-aaaaa2", SESSION, { name: "s" })] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa3", PLAIN)] } },
  ] }, "a");
  // The text size of a card is part of its data, which a kept card keeps.
  plane.currentGrid().card("a").data.textSize = 1.25;
  const tree = { direction: "column", children: [{ tabs: [{ tab: "tab-aaaaa3" }] }, { tabs: [{ plugin: SESSION, params: { name: "s" } }, { tab: "tab-aaaaa1" }], active: 1 }] };
  const applied = await twice("core.layout.apply", { tree });
  assert.equal(plane.currentGrid().card("a").data.textSize, 1.25);
  assert.deepEqual(planned(applied.cards), [["b", ["tab-aaaaa3"]], ["a", ["tab-aaaaa2", "tab-aaaaa1"]]]);
  const { root } = layout();
  assert.equal(root.direction, "column");
  assert.deepEqual(root.children.map(({ card, size }) => [card, size]), [["b", 0.5], ["a", 0.5]]);
  assert.deepEqual(cardNode(root, "a").tabs.map(({ tab, active }) => [tab, active]), [["tab-aaaaa2", false], ["tab-aaaaa1", true]]);
  // A tab that the tree does not hold closes with close true; a modified one refuses the apply.
  const one = { tabs: [{ tab: "tab-aaaaa2" }] };
  reports.reportModified("tab-aaaaa3", true);
  try {
    const before = layout();
    await refuses(run("core.layout.apply", { tree: one, close: true }), "tab tab-aaaaa3 has unsaved changes; core.layout.close asks the person");
    assert.deepEqual(layout(), before);
  } finally {
    reports.reportModified("tab-aaaaa3", false);
  }
  const closed = await run("core.layout.apply", { tree: one, close: true });
  assert.deepEqual([planned(closed.cards), closed.kept, closed.closed], [[["a", ["tab-aaaaa2"]]], [], ["tab-aaaaa3", "tab-aaaaa1"]]);
  assert.deepEqual(cardIds(layout().root), ["a"]);
});

// contract: layout.plan.refusals
test("a plan that cannot resolve its tree states the reason and changes nothing", { timeout: 5000 }, async () => {
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
  ] }, "a");
  const before = layout();
  for (const [tree, reason] of [
    [{ tabs: [{ tab: "tab-zzzzzz" }] }, "tab tab-zzzzzz is not a tab of the active space"],
    [{ tabs: [{ tab: "tab-ooooo1" }] }, "tab tab-ooooo1 is not a tab of the active space"],
    [{ direction: "row", children: [{ tabs: [{ tab: "tab-aaaaa1" }] }, { tabs: [{ tab: "tab-aaaaa1" }] }] }, "tab tab-aaaaa1 stands twice in the tree"],
    [{ tabs: [{ plugin: "nothing" }] }, "unknown plugin nothing"],
    [{ tabs: [{ plugin: PLAIN, params: { name: "x" } }] }, `plugin ${PLAIN} declares no tab params`],
    [{ direction: "row", children: [{ tabs: [{ tab: "tab-aaaaa1" }] }] }, "tree.children must hold at least two nodes"],
  ]) {
    const plan = await run("core.layout.plan", { tree });
    assert.deepEqual([plan.feasible, plan.reason], [false, reason]);
    await refuses(run("core.layout.apply", { tree }), reason);
    assert.deepEqual(layout(), before, reason);
  }
  await refuses(run("core.layout.plan", { tree: { tabs: [{ tab: "tab-aaaaa1" }] }, count: 2 }), "core.layout.plan takes tree or count with plugin, not both");
  await refuses(run("core.layout.plan", { count: 2 }), "core.layout.plan needs tree, or count with plugin");
  await refuses(run("core.layout.plan", { count: 0, plugin: SESSION }), "count must be a whole number of at least 1");
  plane.toggleCardFullscreen("a");
  const shown = await run("core.layout.plan", { count: 2, plugin: SESSION });
  assert.equal(shown.reason, "the layout does not change while card a is fullscreen; restore the arrangement first");
  plane.toggleCardFullscreen("a");
  await run("core.group.create", { card: "b", side: "right", plugin: SESSION });
  const grouped = await run("core.layout.plan", { count: 2, plugin: SESSION });
  assert.equal(grouped.feasible, true, grouped.reason);
  // A flat plan keeps no group card of the space, so its apply ends the group card.
  await twice("core.layout.apply", { tree: grouped.tree });
  assert.deepEqual(layout().groups, []);
});

// contract: layout.apply.groups
test("a group of five cards in a row plans and applies one group card, and a repeated apply changes nothing", { timeout: 5000 }, async () => {
  single([view("tab-aaaaa1", PLAIN)]);
  const tree = { group: { name: "Row" }, tree: { direction: "row", children: terminals(5) } };
  const plan = await run("core.layout.plan", { tree });
  assert.deepEqual([plan.feasible, plan.reason], [true, null]);
  assert.equal(plan.tree.group.name, "Row");
  // A new group card has no identifier in the plan.
  assert.deepEqual(plan.cards.map(({ group }) => group), [null, null, null, null, null]);
  const applied = await twice("core.layout.apply", { tree: plan.tree });
  const { groups, focused } = layout();
  assert.deepEqual(groups.map(({ name, members }) => [name, members.length]), [["Row", 5]]);
  assert.ok(applied.cards.every(({ group }) => group === groups[0].card));
  // The focus goes to the first content card in workbench order.
  assert.equal(focused, applied.cards[0].card);
  // The second apply keeps the group card by its identifier.
  assert.deepEqual(layout().groups.map(({ card }) => card), [groups[0].card]);
  // A plan of the applied tree keeps the group card and its name, and a request name is not applied to a kept group card.
  const renamed = { group: { name: "Other" }, tree: applied.tree.tree };
  const again = await run("core.layout.plan", { tree: renamed });
  assert.equal(again.tree.group.name, "Row");
  assert.ok(again.cards.every(({ group }) => group === groups[0].card));
  await twice("core.layout.apply", { tree: renamed });
  assert.deepEqual(layout().groups.map(({ card, name }) => [card, name]), [[groups[0].card, "Row"]]);
});

// contract: layout.plan.group-refusals
test("a group whose tree is one card or whose name is not 1 to 40 characters is refused and changes nothing", { timeout: 5000 }, async () => {
  arrange({ cut: "x", kids: [
    { share: 0.5, node: { card: "a", tabs: [view("tab-aaaaa1", PLAIN)] } },
    { share: 0.5, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN)] } },
  ] }, "a");
  const before = layout();
  const two = { direction: "row", children: terminals(2) };
  for (const [tree, reason] of [
    [{ group: {}, tree: { tabs: [{ plugin: SESSION }] } }, "a group of the tree holds at least two cards"],
    [{ group: { name: "   " }, tree: two }, "group name must be 1 to 40 characters: "],
    [{ group: { name: "x".repeat(41) }, tree: two }, `group name must be 1 to 40 characters: ${"x".repeat(41)}`],
  ]) {
    const plan = await run("core.layout.plan", { tree });
    assert.deepEqual([plan.feasible, plan.reason], [false, reason]);
    await refuses(run("core.layout.apply", { tree }), reason);
    assert.deepEqual(layout(), before, reason);
  }
});

// contract: exposure.keyboard.closing-the-focused-card-clears-the-ring
test("closing the focused card clears the ring, and closing another card or tab keeps it", { timeout: 5000 }, async () => {
  const three = () => arrange({ cut: "x", kids: [
    { share: 1 / 3, node: { card: "a", tabs: [view("tab-aaaaaa", PLAIN)] } },
    { share: 1 / 3, node: { card: "b", tabs: [view("tab-aaaaa2", PLAIN), view("tab-aaaaa3", PLAIN)] } },
    { share: 1 / 3, node: { card: "c", tabs: [view("tab-aaaaa4", PLAIN)] } },
  ] }, "b");
  // Another card and its tab: the ring stays on b.
  three();
  await run("core.card.close", { card: "c" });
  assert.equal(plane.focused(), "b", "closing another card moved the ring");
  await run("core.layout.close", { tab: "tab-aaaaaa" });
  assert.equal(plane.focused(), "b", "closing the last tab of another card moved the ring");
  // A tab of the focused card while the card stays: the ring stays and the card shows its remaining tab.
  await run("core.layout.close", { tab: "tab-aaaaa3" });
  assert.equal(plane.focused(), "b", "closing a tab of the focused card moved the ring");
  // The focused card by core.card.close: no card holds the ring.
  three();
  await run("core.card.close", { card: "b" });
  assert.equal(plane.focused(), null, "closing the focused card moved the ring to another card");
  await refuses(run("core.layout.close", { tab: "current" }), "card current names no card: window main has no focused card");
  // The focused card by the close of its last tab.
  three();
  await run("core.layout.close", { tab: "tab-aaaaa3" });
  await run("core.layout.close", { tab: "tab-aaaaa2" });
  assert.equal(plane.focused(), null, "closing the last tab of the focused card moved the ring to another card");
});
