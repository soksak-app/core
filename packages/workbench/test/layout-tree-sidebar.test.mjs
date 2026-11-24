// The tree of the layout of the window description for the arrangements of docs/spec/cases/layout/tree.json that hold a place card of a
// window sidebar (docs/spec/exposure.md#window-snapshot): the window of this test declares the sidebars of those cards, so the plane keeps
// them, and the tree leaves them out. layout-operations.test.mjs runs the arrangements without a window sidebar.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";

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
// JSDOM has no layout engine and does not load the application stylesheet.
const planeElement = document.getElementById("plane");
Object.defineProperty(planeElement, "clientWidth", { value: 1600 });
Object.defineProperty(planeElement, "clientHeight", { value: 1200 });
const style = document.createElement("style");
style.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.appendChild(style);
Object.defineProperty(document, "adoptedStyleSheets", { value: [] });

const PLAIN = "fixture-plain";
const SIDES = ["left", "right", "top", "bottom"];
const { cases } = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/layout/tree.json", import.meta.url), "utf8"));
// The card nodes of a stored tree in tree order.
const leaves = (node) => (node.cut !== undefined ? node.kids.flatMap((kid) => leaves(kid.node)) : [node]);
const withSidebar = cases.filter(({ layout }) => leaves(layout.root).some(({ card }) => SIDES.includes(card)));
const sides = [...new Set(withSidebar.flatMap(({ layout }) => leaves(layout.root).map(({ card }) => card).filter((id) => SIDES.includes(id))))];

const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: PLAIN, title: "t" }] } } },
  // Each side of the cases holds a window sidebar with a set of one section.
  sidebars: { sets: [{ id: "set-list", title: "List", sections: ["fixture-sections.list"], layout: "list" }],
    links: sides.map((side) => ({ place: side, plugin: null, set: "set-list" })) },
}, { plugins: [
  { id: PLAIN, package: "@fixture/plain", version: "0.0.1", folder: "/installed/plugin", manifest: { id: PLAIN, name: PLAIN, description: "검사용 표면.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } } } },
  { id: "fixture-sections", package: "@fixture/sections", version: "0.0.1", folder: "/installed/plugin", manifest: { id: "fixture-sections", name: "Sections",
    description: "검사용 섹션.", sections: [{ id: "fixture-sections.list", name: "List", composition: { kind: "view", page: "ui/list.html" }, height: "fill" }] } },
] }), [], "the fixture environment refused a plugin");
// The sidebar draws its section controls, which connect only to declared core commands.
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const plane = await import("../plane.js");

// contract: layout.tree.one-tree-per-arrangement
test("the lines and cards of each arrangement of tree.json with a window sidebar give its root without the place card", { timeout: 5000 }, () => {
  assert.ok(withSidebar.length >= 1, "tree.json holds no arrangement with a window sidebar");
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
  const strip = (node) => (node.card ? { card: node.card, size: node.size }
    : { direction: node.direction, size: node.size, children: node.children.map(strip) });
  for (const { name, layout, root } of withSidebar) {
    const cards = leaves(layout.root).map(({ card }) => card);
    const content = cards.filter((id) => !SIDES.includes(id));
    const drawn = new Soksak(layout, { width: 1600, height: 1200 });
    const first = [...drawn.cards].filter(({ id }) => !SIDES.includes(id)).sort((a, b) => (a.r0 - b.r0) || (a.c0 - b.c0))[0];
    const numbers = cards.map((id) => Number(/^card-(\d+)$/.exec(id)?.[1] ?? 0));
    let i = 0;
    const withData = (node) => {
      if (node.cut !== undefined) return { ...node, kids: node.kids.map((kid) => ({ ...kid, node: withData(kid.node) })) };
      if (SIDES.includes(node.card)) return { ...node, fixed: true, data: null };
      const tab = `tab-side${String(i++).padStart(2, "0")}`;
      return { ...node, data: { tabs: [{ id: tab, plugin: PLAIN, title: "t", origin: { directory: null }, role: null }], activeId: tab } };
    };
    plane.adopt({ focusedId: content[0], named: 0, sidebars: {}, leader: first.id, lastCard: Math.max(1, ...numbers),
      // The plane keeps the size of a window sidebar as it is drawn, so the record holds the extent that the share of the case gives it.
      windowSidebars: Object.fromEntries(cards.filter((id) => SIDES.includes(id)).map((id) =>
        [id, id === "left" || id === "right" ? { width: drawn.rect(id).w } : { height: drawn.rect(id).h }])),
      state: { root: withData(layout.root) } }, "spc-aaaaaa");
    assert.deepEqual(plane.currentGrid().cards.map(({ id }) => id).sort(), [...cards].sort(), `${name}: the plane did not keep the cards of the case`);
    // The plane keeps the cuts of the case; the shares beside a window sidebar follow the gap of the plane.
    const form = (node) => (node.cut !== undefined ? { cut: node.cut, kids: node.kids.map((kid) => form(kid.node)) } : node.card);
    assert.deepEqual(form(plane.currentGrid().toJSON().root), form(layout.root), `${name}: the plane changed the cuts of the case`);
    close(strip(plane.layoutDescription().root), root, name);
  }
});
