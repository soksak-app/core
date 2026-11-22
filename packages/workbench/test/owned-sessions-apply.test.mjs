// A new tab of core.layout.apply whose params name an owned session shows that session on the main page, against the page-wire case
// owned-sessions-apply: the tab becomes the showing tab of core.sessions and sends the size of its card at once, as a tab of
// core.layout.open does (docs/spec/plugins.md#owned-sessions).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const SESSION = "fixture-session";
const SIDECAR = "@scope/fixture-sidecar";
const OWNER = "tab-aaaaa1";
const OPEN_SIZE = { width: 640, height: 384, scale: 2 };
// The page-wire case answers every call of the page in order; it is selected before the modules that read the host are imported.
const wire = selectPageWire("owned-sessions-apply");

const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), CSS: dom.window.CSS, PointerEvent: dom.window.PointerEvent,
  MouseEvent: dom.window.MouseEvent, ErrorEvent: dom.window.ErrorEvent,
  addEventListener: dom.window.addEventListener.bind(dom.window), dispatchEvent: dom.window.dispatchEvent.bind(dom.window),
  devicePixelRatio: dom.window.devicePixelRatio })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
Object.defineProperty(document.getElementById("plane"), "clientWidth", { value: 1600 });
Object.defineProperty(document.getElementById("plane"), "clientHeight", { value: 1200 });
// JSDOM loads no application stylesheet: the cards get the border and divider widths that the plane reads.
const style = document.createElement("style");
style.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.appendChild(style);
Object.defineProperty(document, "adoptedStyleSheets", { value: [] });

const manifest = {
  id: SESSION, name: SESSION, description: "검사용 표면.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] },
    params: { type: "object", properties: { session: { type: "string" } } } },
  dependencies: { [SIDECAR]: "1.0.0" },
  sessions: true,
};
const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: SESSION, title: "t" }] } } },
  sidebars: { sets: [], links: [] },
}, { plugins: [{ id: SESSION, package: "@fixture/session", version: "0.0.1", manifest }] }), [], "the fixture environment refused a plugin");
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { begin } = await import("../projects.js");
const plane = await import("../plane.js");
const { applySessionCheck, applySessionShow, installCoreExposure } = await import("../core-exposure.js");
const { endOwnedSession, openOwnedSession, ownedSessionsState } = await import("../owned-sessions.js");
const { flushEvents } = await import("../page-log.js");
// The stored policy of the settings, which the page applies at its start, stores the lifecycle events at info (the case records them).
const { logGate, logPolicyOf } = await import("../log-gate.js");
logGate.set(logPolicyOf({ lifecycle: "info" }));
const { pageMemorySaver } = await import("./support/memory-saver.mjs");
await installCoreExposure({ library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
plane.nameWindow("main");
begin({ common: { "diagnostics.log": { lifecycle: "info" } }, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main", lastCard: 1, state: {
    root: { card: "main", data: { tabs: [{ id: OWNER, plugin: SESSION, title: SESSION, origin: { directory: null }, role: null }], activeId: OWNER } } } } },
], activeSpaceId: "spc-aaaaaa", named: 2 }] });

const STORED = { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main", lastCard: 1, state: {
  root: { card: "main", data: { tabs: [{ id: OWNER, plugin: SESSION, title: SESSION, origin: { directory: null }, role: null }], activeId: OWNER } } } };
const tree = (session) => ({ tree: { direction: "row", children: [{ tabs: [{ tab: OWNER }] }, { tabs: [{ plugin: SESSION, params: { session } }] }] } });

test("a layout apply refuses a new tab that names a session that is not open and leaves the layout", { timeout: 5000 }, () => {
  plane.adopt(STORED, "spc-aaaaaa");
  const before = plane.layoutDescription();
  assert.throws(() => plane.applyInLayout(tree("ses-missing"), applySessionCheck), /^Error: session ses-missing is not open$/);
  assert.deepEqual(plane.layoutDescription(), before);
});

test("a new tab of a layout apply that names a session shows it and sends the size of its card", { timeout: 5000 }, async () => {
  const { session } = await openOwnedSession({ plugin: SESSION, params: { name: "agent" }, size: OPEN_SIZE }, OWNER);
  const applied = plane.applyInLayout(tree(session), applySessionCheck, applySessionShow);
  const shown = applied.cards[1].tabs[0].tab;
  assert.deepEqual(ownedSessionsState(), [{ session, plugin: SESSION, owner: OWNER, shownBy: shown, program: null }]);
  await endOwnedSession({ session }, OWNER);
  await flushEvents();
  assert.deepEqual(wire.calls.filter(({ name }) => name === "sidecarSend").map(({ payload }) => payload.body.operation), ["open", "resize", "end"]);
  wire.finish();
});
