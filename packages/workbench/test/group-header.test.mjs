// The pointer on the header of a group card in the page workbench (docs/spec/groups.md#headers, docs/spec/groups.md#moving-and-dropping):
// the rename of a group by a double-click on its name and the rename commands, and the drag of a group card by its header, run through
// the registry and the elements of the page without a host, as in the browser runtime. The plane holds one group card of two cards
// beside a card of the root level.
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
const projects = await import("../projects.js");
const plane = await import("../plane.js");
const { bind, run } = await import("../commands.js");
const { createBarTabs } = await import("../bar-tabs.js");
const barTabs = createBarTabs({ projects, projectBar: document.getElementById("projectBar"), spaceBar: document.getElementById("spaceBar"),
  workarea: document.getElementById("workarea"), bind, run, redraw: () => {}, keyboardOwed: () => {}, changed: () => {},
  groups: plane.groupRenames });
// The page gives the group cards to the rename of the bars, which index.html connects in the application.
plane.useGroupRename?.(barTabs.renames);
const { installCoreExposure } = await import("../core-exposure.js");
await installCoreExposure({ library: { state: () => null }, renames: barTabs.renames, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
// The window of the page has the name that its start document carries (docs/spec/native-host.md#page-start).
plane.nameWindow(WINDOW);

const view = (id, plugin) => ({ id, plugin, title: id, origin: { directory: null } });
const content = (id, tabs) => ({ card: id, data: { tabs, activeId: tabs[0].id } });
/** A cut along x of the kids, each [share, node]. */
const row = (kids) => ({ cut: "x", kids: kids.map(([share, node]) => ({ share, node })) });
projects.begin({ common: {}, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main",
    lastCard: 1, state: { root: content("main", [view("tab-aaaaa1", PLAIN)]) } } },
], activeSpaceId: "spc-aaaaaa", named: 1 }] });

/** Shows three cards in a row, card-1, card-2 and card-3, whose first two are the group card-4 named 그룹 1, with card-3 focused. */
function arrange() {
  plane.closePicker("fixture reset");
  plane.adopt({ focusedId: "card-3", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 4, leader: "card-4",
    state: { root: row([
      [0.75, { box: "card-4", data: { name: "그룹 1", leader: "card-1" }, inner: row([[0.5, content("card-1", [view("tab-aaaaa1", PLAIN)])],
        [0.5, content("card-2", [view("tab-aaaaa2", PLAIN)])]]) }],
      [0.25, content("card-3", [view("tab-aaaaa3", PLAIN)])],
    ]) } }, "spc-aaaaaa");
}
/** The name of the group card id in the stored tree of the layout layout, which its box holds as data. */
const groupName = (layout, id) => {
  const find = (node) => (node.box === id ? node : node.box ? find(node.inner) : node.cut ? node.kids.map((kid) => find(kid.node)).find(Boolean) : undefined);
  return find(layout.state.root)?.data.name;
};
const status = async (name) => (await registry.handle({ id: 1, method: "status.get", params: { name } })).result;
const refuses = (promise, text) => assert.rejects(promise, (error) => error.message === text, `does not fail with ${text}`);
const groupElement = (id) => document.querySelector(`#plane > .group[data-group-card="${id}"]`);
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));
/** Dispatches a pointer event of type at x, y of the plane on element, whose pointer capture JSDOM does not hold. */
function pointer(element, type, x, y) {
  element.setPointerCapture ??= () => {};
  element.hasPointerCapture ??= () => true;
  element.releasePointerCapture ??= () => {};
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
  element.dispatchEvent(event);
}

test("a double-click on the name of a group card begins its rename, and the commit renames the group", { timeout: 5000 }, async () => {
  arrange();
  await settled();
  const name = groupElement("card-4").querySelector(".group__name");
  name.getBoundingClientRect = () => ({ left: 20, top: 10, right: 120, bottom: 25, x: 20, y: 10, width: 100, height: 15 });
  name.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 40, clientY: 18 }));
  await settled();
  assert.deepEqual(await status("core.rename"), { kind: "group", id: "card-4", value: "그룹 1" }, "a double-click on the name did not begin the rename");
  const field = groupElement("card-4").querySelector(".group__head [data-expose='core.rename.input']");
  assert.ok(field, "the header of the group card shows no rename field");
  await run("core.rename.set", { value: "  작업  " });
  await run("core.rename.commit");
  await settled();
  assert.equal(await status("core.rename"), null);
  assert.equal(groupName(await status("core.layout"), "card-4"), "작업", "the commit did not rename the group");
  assert.equal(groupElement("card-4").querySelector(".group__name").textContent, "작업");
  assert.equal(groupElement("card-4").querySelector("[data-expose='core.rename.input']"), null, "the rename field stays after the commit");
  await run("core.rename.begin", { kind: "group", id: "card-4" });
  await run("core.rename.set", { value: "   " });
  await run("core.rename.commit");
  assert.equal(groupName(await status("core.layout"), "card-4"), "작업", "an empty name changed the name");
  await refuses(run("core.rename.begin", { kind: "group", id: "card-1" }), "no group card-1");
});

// A press on the header takes the pointer capture for a drag, so WebKit targets the click and the double-click at the header, the
// common target of the press and the release, not at the name under the pointer: the double-click begins the rename by its point.
test("a double-click on the name of a group card that its header captured begins the rename", { timeout: 5000 }, async () => {
  arrange();
  await settled();
  const header = groupElement("card-4").querySelector(".group__head");
  const name = header.querySelector(".group__name");
  name.getBoundingClientRect = () => ({ left: 20, top: 10, right: 120, bottom: 25, x: 20, y: 10, width: 100, height: 15 });
  pointer(name, "pointerdown", 40, 18);
  pointer(header, "pointerup", 40, 18);
  header.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 40, clientY: 18 }));
  await settled();
  assert.deepEqual(await status("core.rename"), { kind: "group", id: "card-4", value: "그룹 1" }, "a double-click on the name did not begin the rename");
  await run("core.rename.cancel");
  header.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 300, clientY: 18 }));
  await settled();
  assert.equal(await status("core.rename"), null, "a double-click on the header beside the name began the rename");
});

test("a drag of a group header previews its move, reports the drag and runs core.card.move at the release", { timeout: 5000 }, async () => {
  arrange();
  await settled();
  const header = groupElement("card-4").querySelector(".group__head");
  const tree = plane.currentTree();
  const head = tree.headRect("card-4");
  const target = tree.rect("card-3");
  const [x0, y0] = [head.x + 8, head.y + head.h / 2];
  const [x1, y1] = [target.x + target.w - 4, target.y + target.h / 2];
  pointer(header, "pointerdown", x0, y0);
  pointer(header, "pointermove", x1, y1);
  const drag = await status("core.drag");
  assert.equal(drag?.card, "card-4", "a drag of the header of card-4 reports no drag of the group card");
  assert.deepEqual({ tab: drag.tab, moved: drag.moved, target: drag.target }, { tab: "", moved: true, target: { card: "card-3", zone: "right" } });
  pointer(header, "pointerup", x1, y1);
  await settled();
  assert.equal(await status("core.drag"), null);
  const placed = Object.fromEntries(plane.currentGrid().cards.map(({ id, c0, c1 }) => [id, [c0, c1]]));
  assert.ok(placed["card-1"][0] >= placed["card-3"][1] && placed["card-2"][0] >= placed["card-3"][1],
    `the release did not move card-4 to the right of card-3: ${JSON.stringify(placed)}`);
  assert.equal(plane.focused(), "card-1", "the move of the group card did not focus the first card inside it");
  // The group card moves inside its own level, so it keeps the leader mark of the level, and the stored layout names a member of each
  // level as its leader (docs/spec/groups.md#leader).
  const layout = await status("core.layout");
  assert.equal(layout.leader, "card-4", "the move of the group card inside its level changed the leader of the level");
  assert.deepEqual(drag.preview, plane.currentTree().rect("card-4"), "the preview is not the rectangle that the move gave the group card");
  // A release with no zone changes nothing.
  const before = JSON.stringify(plane.currentGrid().toJSON());
  const moved = groupElement("card-4").querySelector(".group__head");
  const again = plane.currentTree().headRect("card-4");
  pointer(moved, "pointerdown", again.x + 8, again.y + again.h / 2);
  pointer(moved, "pointermove", again.x + 40, again.y + again.h / 2);
  assert.equal((await status("core.drag"))?.target ?? null, null, "a point inside the dragged group card resolved a zone");
  pointer(moved, "pointerup", again.x + 40, again.y + again.h / 2);
  await settled();
  assert.equal(JSON.stringify(plane.currentGrid().toJSON()), before, "a release with no zone changed the layout");
});
