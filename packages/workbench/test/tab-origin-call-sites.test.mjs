// The call sites of the tab origin in the plane (docs/spec/projects.md#tab-origin, docs/spec/native-surfaces.md#view-surfaces): the
// last-tab close records a null origin (F238-a-9), a restored view tab starts with its stored origin (F238-a-10), and a refused view tab
// is logged and shown on its tab (F238-a-16). The unit tests of tab-reports.js cover the recording; these tests reach the call sites
// through the plane, so that removing one call fails a test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const plainId = "fixture-origin-plain";
const viewId = "fixture-origin-view";
const version = "0.0.1";
const MISSING = 'surface "%ID%": view start origin is missing';

// The host calls of the page are answered by the page-wire case tab-origin-call-sites-session (docs/spec/cases/page-wire/README.md). The case
// is selected before the modules are imported, because the page reads the host when it imports them.
const wire = selectPageWire("tab-origin-call-sites-session");

// The page of the window is drawn in this document, which the plane reads at its import (plane.js).
const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true,
  addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// The plane aligns itself to the device pixel grid of this scale on every draw (device-grid.js).
globalThis.devicePixelRatio = dom.window.devicePixelRatio;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS;
globalThis.PointerEvent = dom.window.PointerEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
const planeEl = document.getElementById("plane");
Object.defineProperty(planeEl, "clientWidth", { value: 800 });
Object.defineProperty(planeEl, "clientHeight", { value: 600 });
const style = document.createElement("style");
style.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.appendChild(style);
// JSDOM has no adoptedStyleSheets, which the page reads when it shows a modal; no sheet is adopted here.
Object.defineProperty(document, "adoptedStyleSheets", { value: [] });
after(() => dom.window.close());

// The environment of the page: the view plugin is a loaded plugin, and the plugin of the plain tab is not, so its tab is not a view tab. The card is fixed,
// so that the close of its last tab opens a tab (F238-a-9).
const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
    { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, fixed: true, tabs: [{ plugin: plainId, title: "only" }] },
  ] } },
  sidebars: { sets: [], links: [] },
}, { plugins: [{ id: viewId, package: "@fixture/origin-view", version, manifest: {
  id: viewId, name: "View", description: "검사용 view.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html" }, params: { type: "object", properties: {} } },
} }] }), [], "the fixture environment refused a plugin");
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const loaded = { plane: await import("../plane.js"), tabOrigins: await import("../tab-reports.js") };
const { flushEvents } = await import("../page-log.js");

// The error lines that the page wrote to the log of the host since the call at index `from`, as `<where>: <text>` (logRefusals writes the refusal text).
async function errorLines(from) {
  await flushEvents();
  return wire.calls.slice(from).filter(({ name, payload }) => name === "log" && payload.action === "batch")
    .flatMap(({ payload }) => payload.events).filter(({ event }) => event === "workbench.record.error")
    .map(({ fields }) => `${fields.where}: ${fields.text}`);
}

/** Returns the plane module and the origins, and the index of the first call of the test, from which the error lines are read. */
function setup() {
  return { ...loaded, from: wire.calls.length };
}

test("a restored view tab starts with its stored origin on the first build of the plane (F238-a-10)", { timeout: 5000 }, async () => {
  const env = setup();
  // The first call of adopt builds the plane (grid is absent), so this test is the one that reaches the build call site.
  const kept = env.plane.fresh();
  const card = kept.state.cards.find((entry) => entry.id === "main");
  card.data.tabs = [{ id: "built-view", plugin: viewId, title: "v", params: {}, origin: { directory: "/b" } }];
  card.data.activeId = "built-view";
  env.plane.adopt(kept, "spc-aaaaaa");
  assert.deepEqual(env.tabOrigins.tabOrigin("built-view"), { directory: "/b" }, "the first build did not restore the stored origin");
  assert.equal(env.tabOrigins.viewRefusal("built-view"), null);
  assert.deepEqual(await errorLines(env.from), [], "the first build wrote a refusal for a valid origin");
});

test("closing the last tab of a fixed card opens a tab that records a null origin without throwing (F238-a-9)", { timeout: 5000 }, async () => {
  const env = setup();
  env.plane.adopt(env.plane.fresh(), "spc-aaaaaa");
  const card = env.plane.currentGrid().card("main");
  const only = card.data.tabs[0];
  assert.equal(card.data.tabs.length, 1, "the fixture does not start with one tab");
  const closed = await env.plane.closeTabById(only.id);
  assert.deepEqual(closed, { closed: true });
  const opened = card.data.tabs;
  assert.equal(opened.length, 1, "closing the last tab of a fixed card did not open a replacement tab");
  assert.notEqual(opened[0].id, only.id);
  assert.deepEqual(env.tabOrigins.tabOrigin(opened[0].id), { directory: null },
    "the replacement tab of the last-tab close did not record the null origin of its closed source");
});

test("a restored view tab starts with its stored origin and is not refused (F238-a-10)", { timeout: 5000 }, async () => {
  const env = setup();
  const kept = env.plane.fresh();
  const card = kept.state.cards.find((entry) => entry.id === "main");
  card.data.tabs = [
    { id: "restored-view", plugin: viewId, title: "v", params: {}, origin: { directory: "/a" } },
  ];
  card.data.activeId = "restored-view";
  env.plane.adopt(kept, "spc-aaaaaa");
  assert.deepEqual(env.tabOrigins.tabOrigin("restored-view"), { directory: "/a" },
    "the restored view tab did not start with its stored origin");
  assert.equal(env.tabOrigins.viewRefusal("restored-view"), null);
  assert.deepEqual(await errorLines(env.from), [], "a valid restored origin wrote a refusal to the application log");
});

test("a refused view tab is written to the application log and shown on its tab (F238-a-16)", { timeout: 5000 }, async () => {
  const env = setup();
  const kept = env.plane.fresh();
  const card = kept.state.cards.find((entry) => entry.id === "main");
  card.data.tabs = [
    { id: "refused-view", plugin: viewId, title: "v", params: {} },
    { id: "plain-tab", plugin: plainId, title: "p", params: {} },
  ];
  card.data.activeId = "refused-view";
  env.plane.adopt(kept, "spc-aaaaaa");
  const text = MISSING.replace("%ID%", "refused-view");
  // The log holds the refusal once from the layout read and once from the tab error path (reportError writes its own line).
  assert.deepEqual(await errorLines(env.from), [text, `tab error refused-view: ${text}`], "the refused view tab was not written to the application log");
  assert.equal(env.tabOrigins.viewRefusal("refused-view"), text);
  assert.equal(env.tabOrigins.tabError("refused-view"), text, "the refused view tab does not show its refusal on the tab");
  assert.equal(env.tabOrigins.tabError("plain-tab"), null, "a non-view tab shows an origin refusal");
});

test("the page sent only the calls that its case records", { timeout: 5000 }, async () => {
  await flushEvents();
  wire.finish();
});
