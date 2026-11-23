// The restart of the main page against the page-wire case owned-sessions-restart: the owned sessions that the sidecar holds are adopted
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
// A restored tab whose params name a session that the service no longer holds.
const STALE = "tab-aaaaa2";
// A restored tab of a plugin that declares no sessions and no sidecar, which owns a session that the plugin SESSION opened.
const ROOM = "tab-aaaaa3";
const ROOM_PLUGIN = "fixture-room";
// The page-wire case answers every call of the page in order; it is selected before the modules that read the host are imported.
const wire = selectPageWire("owned-sessions-restart");

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
}, { plugins: [{ id: SESSION, package: "@fixture/session", version: "0.0.1", manifest },
  { id: ROOM_PLUGIN, package: "@fixture/room", version: "0.0.1", manifest: { id: ROOM_PLUGIN, name: ROOM_PLUGIN, description: "검사용 방.", mark: "r",
    icon: "<path/>", surface: manifest.surface } }] }), [], "the fixture environment refused a plugin");
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { begin } = await import("../projects.js");
const plane = await import("../plane.js");
// The stored layout is read before the page start: the restart reconciliation reads the restored tabs when the start is done.
begin({ common: { "diagnostics.log": { lifecycle: "info" } }, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main", lastCard: 1, state: {
    root: { card: "main", data: { tabs: [
      { id: OWNER, plugin: SESSION, title: SESSION, params: { session: "ses-keep" }, origin: { directory: null }, role: null },
      { id: STALE, plugin: SESSION, title: SESSION, params: { session: "ses-missing" }, origin: { directory: null }, role: null },
      { id: ROOM, plugin: ROOM_PLUGIN, title: ROOM_PLUGIN, params: {}, origin: { directory: null }, role: null },
    ], activeId: OWNER } } } } },
], activeSpaceId: "spc-aaaaaa", named: 2 }] });
const { installCoreExposure } = await import("../core-exposure.js");
const { ownedSessionsState, startOwnedSessions } = await import("../owned-sessions.js");
const { flushEvents } = await import("../page-log.js");
// The stored policy of the settings, which the page applies at its start, stores the lifecycle events at info (the case records them).
const { logGate, logPolicyOf } = await import("../log-gate.js");
logGate.set(logPolicyOf({ lifecycle: "info" }));
const { pageMemorySaver } = await import("./support/memory-saver.mjs");
await installCoreExposure({ library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
plane.nameWindow("main");

test("the restart adopts the session whose owner is in the restored layout, ends the session whose owner is absent and states the session that did not return", async () => {
  await startOwnedSessions();
  // The restored tab that names the adopted session shows it, and the tab whose session did not return shows the error
  // restored tab <tab>: session <id> is not open (docs/spec/plugins.md#owned-sessions).
  // The session that the room owns belongs to the plugin that opened it, which its entry names (docs/spec/persistent-services.md#owned-sessions).
  // The adopted session keeps the program state that its entry lists, because a program reports its state only when it changes.
  assert.deepEqual(ownedSessionsState(), [{ session: "ses-keep", plugin: SESSION, owner: OWNER, shownBy: OWNER, program: { state: "idle" }, params: { program: "claude", role: "manager-lead" } },
    { session: "ses-room", plugin: SESSION, owner: ROOM, shownBy: null, program: null, params: null }]);
  // The error of the restored tab shows as a toast of the error display, and the close of that tab withdraws it, because the state
  // that it describes ended with the tab (docs/spec/exposure.md#error-presentation).
  const { errorToasts } = await import("../shown-errors.js");
  const { recordClosedTabs } = await import("../closed-tabs.js");
  assert.equal(errorToasts(document).text(`restored tab ${STALE}`), "session ses-missing is not open");
  recordClosedTabs([STALE]);
  assert.equal(errorToasts(document).text(`restored tab ${STALE}`), null);
  assert.equal(errorToasts(document).newest(), null);
  // The batch of the owner-absent end is sent after its microtasks, so the test waits for it before the case is judged.
  await flushEvents();
  wire.finish();
});
