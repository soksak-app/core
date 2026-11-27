// The card size of an owned session on the main page against the page-wire case owned-sessions-frame: showing the session sends the size of
// its card at once, and a card frame sends a resize only when the size changed and no resize of that size is pending
// (docs/spec/plugins.md#owned-sessions, docs/spec/persistent-services.md#owned-session-messages).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

const SESSION = "fixture-session";
const SIDECAR = "@scope/fixture-sidecar";
const OWNER = "tab-aaaaa1";
const OPEN_SIZE = { width: 640, height: 384, scale: 2 };
const LARGE_CARD = { width: 1000, height: 600, scale: 2 };
const SMALL_CARD = { width: 800, height: 500, scale: 2 };
// The page-wire case answers every call of the page in order; it is selected before the modules that read the host are imported.
const wire = selectPageWire("owned-sessions-frame");

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
const { installCoreExposure } = await import("../core-exposure.js");
const { bindShown, cardFrameChanged, cardFramesRedrawn, endOwnedSession, openOwnedSession, ownedSessionsState } = await import("../owned-sessions.js");
const { flushEvents } = await import("../page-log.js");
// The stored policy of the settings, which the page applies at its start, stores the lifecycle events at info (the case records them).
const { logGate, logPolicyOf } = await import("../log-gate.js");
logGate.set(logPolicyOf({ lifecycle: "info" }));
const { pageMemorySaver } = await import("./support/memory-saver.mjs");
await installCoreExposure({ home: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });
plane.nameWindow("main");
begin({ common: { "diagnostics.log": { lifecycle: "info" } }, open: [], projects: [{ id: "prj-aaaaaa", root: "/work/project", spaces: [
  { id: "spc-aaaaaa", title: "SPACE1", layout: { focusedId: "main", named: 0, windowSidebars: {}, sidebars: {}, leader: "main", lastCard: 1, state: {
    root: { card: "main", data: { tabs: [{ id: OWNER, plugin: SESSION, title: SESSION, origin: { directory: null }, role: null }], activeId: OWNER } } } } },
], activeSpaceId: "spc-aaaaaa", named: 2 }] });

test("a shown session takes the card size at once, and a card frame sends a resize only when the size changed and none is pending", { timeout: 5000 }, async () => {
  const { session } = await openOwnedSession({ plugin: SESSION, params: { name: "agent" }, size: OPEN_SIZE }, OWNER);
  // Showing the session sends the size of its card at once, and the resize is held by the case until the test releases it.
  bindShown(session, OWNER, LARGE_CARD);
  await drained();
  assert.deepEqual(ownedSessionsState(), [{ session, plugin: SESSION, owner: OWNER, shownBy: OWNER, program: null, params: { name: "agent" } }]);
  // A frame of the same size while the resize is pending sends nothing.
  cardFrameChanged(OWNER, LARGE_CARD);
  await drained();
  wire.release("sidecarSend");
  await drained();
  // A frame of the size that the session has sends nothing; a frame of another size sends one resize.
  cardFrameChanged(OWNER, LARGE_CARD);
  await drained();
  // A redraw of the plane reads the frame of each shown tab: a hidden card and an unchanged frame send nothing.
  cardFramesRedrawn(() => null);
  cardFramesRedrawn((tab) => (tab === OWNER ? LARGE_CARD : null));
  await drained();
  cardFramesRedrawn((tab) => (tab === OWNER ? SMALL_CARD : null));
  await drained();
  await endOwnedSession({ session }, OWNER);
  await flushEvents();
  assert.deepEqual(wire.calls.filter(({ name }) => name === "sidecarSend").map(({ payload }) => payload.body.operation),
    ["open", "resize", "resize", "end"]);
  wire.finish();
});
