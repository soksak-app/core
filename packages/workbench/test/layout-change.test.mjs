// Every command that changes the stored layout of the active space, one that answers at once and one that answers later, is the
// event workbench.layout.change with its name, its parameters, its answer and the stored layout that it left; a command that leaves
// the layout as it was and a command that fails write none (docs/spec/events.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), CSS: dom.window.CSS, PointerEvent: dom.window.PointerEvent,
  MouseEvent: dom.window.MouseEvent, addEventListener: dom.window.addEventListener.bind(dom.window),
  devicePixelRatio: dom.window.devicePixelRatio })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const planeElement = document.getElementById("plane");
Object.defineProperty(planeElement, "clientWidth", { value: 1600 });
Object.defineProperty(planeElement, "clientHeight", { value: 1200 });
const style = document.createElement("style");
style.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.appendChild(style);

// The calls of the event writer are answered by the page-wire case of this test (docs/spec/cases/page-wire/README.md). The case is
// selected before the modules that read the host are imported.
const wire = selectPageWire("layout-change-commands");
const PLAIN = "fixture-plain";
const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: PLAIN, title: "t" }] }] } },
  sidebars: { sets: [], links: [] },
}, { plugins: [{ id: PLAIN, package: "@fixture/plain", version: "0.0.1", manifest: { id: PLAIN, name: PLAIN, description: "검사용 표면.",
  mark: "f", icon: "<path/>", surface: { composition: { kind: "view", page: "ui/index.html" } } } }] }), []);
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { logGate } = await import("../log-gate.js");
const { flushEvents } = await import("../page-log.js");
const plane = await import("../plane.js");
const { installCoreExposure } = await import("../core-exposure.js");
const { pageMemorySaver } = await import("./support/memory-saver.mjs");
await installCoreExposure({ library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
plane.nameWindow("main");
// The event is of the class call at the level debug, which this policy stores.
logGate.set({ lifecycle: "error", input: "error", call: "debug", io: "error", frame: "error" });

const content = (id, c0, c1, r0, r1) => {
  const tabs = [{ id: `tab-${id.slice(5)}aaaa`, plugin: PLAIN, title: id, origin: { directory: null } }];
  return { id, c0, c1, r0, r1, data: { tabs, activeId: tabs[0].id } };
};
plane.adopt({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 3, leader: "card-3",
  groups: [{ card: "card-3", name: "그룹 1", leader: "card-1", members: ["card-1", "card-2"] }],
  state: { xs: [0, 0.5, 1], ys: [0, 1], cards: [content("card-1", 0, 1, 0, 1), content("card-2", 1, 2, 0, 1)] } }, "spc-aaaaaa");

// A command that answers in a later step: it waits for a task of the event loop and then renames the group.
registry.declare("core", { status: [], element: [], commands: [{ name: "core.fixture.rename-later", description: "Renames the group later.",
  params: { type: "object", properties: { name: { type: "string" } } }, result: { type: "null" } }] });
registry.command("core.fixture.rename-later", async ({ name }) => {
  await new Promise((resolve) => setImmediate(resolve));
  plane.renameGroup("card-3", name);
  return null;
});

test("a command that changes the layout is the event workbench.layout.change with the layout that it left", { timeout: 10000 }, async () => {
  const split = await registry.run("core.card.split", { card: "card-2", side: "bottom", plugin: PLAIN });
  await registry.run("core.card.focus", { card: "card-1" });
  await assert.rejects(registry.run("core.group.rename", { group: "card-1", name: "x" }));
  await registry.run("core.group.rename", { group: "card-3", name: "그룹 2" });
  await registry.run("core.fixture.rename-later", { name: "그룹 3" });
  await flushEvents();
  const events = wire.calls.filter(({ name, payload }) => name === "log" && payload?.action === "batch").flatMap(({ payload }) => payload.events)
    .filter(({ event }) => event === "workbench.layout.change");
  assert.deepEqual(events.map(({ level, fields }) => [level, fields.command, fields.params, fields.paramsTruncated, fields.layoutTruncated]), [
    ["debug", "core.card.split", '{"card":"card-2","side":"bottom","plugin":"fixture-plain"}', false, false],
    ["debug", "core.group.rename", '{"group":"card-3","name":"그룹 2"}', false, false],
    ["debug", "core.fixture.rename-later", '{"name":"그룹 3"}', false, false],
  ]);
  assert.equal(events[0].fields.result, JSON.stringify(split));
  assert.equal(events[1].fields.result, '{"group":"card-3","name":"그룹 2"}');
  assert.equal(events[2].fields.result, "null");
  const layouts = events.map(({ fields }) => JSON.parse(fields.layout));
  assert.deepEqual(layouts.map((layout) => Object.keys(layout)), [["state", "groups", "leader", "lastCard"], ["state", "groups", "leader", "lastCard"],
    ["state", "groups", "leader", "lastCard"]]);
  assert.deepEqual(layouts[0].state.cards.map((card) => card.id), ["card-1", "card-2", split.card]);
  assert.deepEqual(layouts.map((layout) => layout.groups[0].name), ["그룹 1", "그룹 2", "그룹 3"]);
  assert.equal(layouts[0].lastCard, 4);
  wire.finish();
});
