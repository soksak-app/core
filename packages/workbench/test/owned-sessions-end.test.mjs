// The restart of the main page against the page-wire case owned-sessions-end: the owned sessions that the sidecar holds are adopted
// when their owner surface is in the restored layout, and the others are ended with reason owner-absent
// (docs/spec/persistent-services.md#owned-sessions).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const SESSION = "fixture-session";
const SIDECAR = "@scope/fixture-sidecar";
const OWNER = "tab-aaaaa1";
// The page-wire case answers every call of the page in order; it is selected before the modules that read the host are imported.
const wire = selectPageWire("owned-sessions-end");

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
Object.defineProperty(document, "adoptedStyleSheets", { value: [] });

const manifest = {
  id: SESSION, name: SESSION, description: "검사용 표면.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/index.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
  dependencies: { [SIDECAR]: "1.0.0" },
  sessions: true,
};
const { installEnvironment } = await import("../environment.js");
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: SESSION, title: "t" }] } } },
  sidebars: { sets: [], links: [] },
}, { plugins: [{ id: SESSION, package: "@fixture/session", version: "0.0.1", folder: "/installed/plugin", manifest }] }), [], "the fixture environment refused a plugin");
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { begin } = await import("../projects.js");
const plane = await import("../plane.js");
// The stored layout is read before the page start: the restart reconciliation reads the restored tabs when the start is done.
begin({ common: { "diagnostics.log": { lifecycle: "info" } }, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main", lastCard: 1, state: {
    root: { card: "main", data: { tabs: [{ id: OWNER, plugin: SESSION, title: SESSION, origin: { directory: null }, role: null }], activeId: OWNER } } } } },
], activeSpaceId: "spc-aaaaaa", named: 2 }] });
const { installCoreExposure } = await import("../core-exposure.js");
const { ownedSessionsState, startOwnedSessions } = await import("../owned-sessions.js");
const { flushEvents } = await import("../page-log.js");
// The stored policy of the settings, which the page applies at its start, stores the lifecycle events at info (the case records them).
const { logGate, logPolicyOf } = await import("../log-gate.js");
logGate.set(logPolicyOf({ lifecycle: "info" }));
const { pageMemorySaver } = await import("./support/memory-saver.mjs");
await installCoreExposure({ home: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
plane.nameWindow("main");

test("session.ended of the owner ends its session once and refuses its repetition", async () => {
  await startOwnedSessions();
  assert.deepEqual(ownedSessionsState(), [{ session: "ses-keep", plugin: SESSION, owner: OWNER, shownBy: null, program: null, params: { program: "claude", role: "manager-lead" } }]);
  wire.deliverNotice();
  assert.deepEqual(ownedSessionsState(), []);
  wire.deliverNotice();
  assert.deepEqual(ownedSessionsState(), []);
  await flushEvents();
  wire.finish();
});
