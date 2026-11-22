// The owned session messages of the main page against the page-wire case owned-sessions-open: the restart listing, and open, resize,
// input, submit, read, program and end through the owner surface (docs/spec/plugins.md#owned-sessions, docs/spec/persistent-services.md#owned-session-messages).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const SESSION = "fixture-session";
const SIDECAR = "@scope/fixture-sidecar";
const OWNER = "tab-aaaaa1";
// The page-wire case answers every call of the page in order; it is selected before the modules that read the host are imported.
const wire = selectPageWire("owned-sessions-open");

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
}, { plugins: [{ id: SESSION, package: "@fixture/session", version: "0.0.1", manifest }] }), [], "the fixture environment refused a plugin");
const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { begin } = await import("../projects.js");
const plane = await import("../plane.js");
const { installCoreExposure } = await import("../core-exposure.js");
const { endOwnedSession, inputOwnedSession, openOwnedSession, ownedSessionsState, readOwnedSession, resizeOwnedSession, startOwnedSessions, submitOwnedSession } = await import("../owned-sessions.js");
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

// The commands are called as their module functions here: a command run also records its own debug event, which the policy of this case
// does not store, so the case would depend on when the page reports the counts of the events that it gated.
test("core.session.open refuses a size whose width, height or scale is not positive before any sidecar request", async () => {
  await assert.rejects(openOwnedSession({ plugin: SESSION, params: {}, size: { width: 0, height: 384, scale: 2 } }, OWNER),
    /size width, height and scale must be positive numbers/);
});

test("the owned session messages open, resize and end a session through the owner surface", async () => {
  // The restart reconciliation reads the sessions of the sidecar, which the case answers with none.
  await startOwnedSessions();
  const opened = await openOwnedSession({ plugin: SESSION, params: { name: "agent" }, size: { width: 640, height: 384, scale: 2 } }, OWNER);
  assert.deepEqual(opened, { session: "ses-1" });
  assert.deepEqual(ownedSessionsState(), [{ session: "ses-1", plugin: SESSION, owner: OWNER, shownBy: null, program: null }]);
  assert.deepEqual(await resizeOwnedSession({ session: "ses-1", size: { width: 1000, height: 600, scale: 2 } }, OWNER),
    { session: "ses-1", size: { width: 1000, height: 600, scale: 2 } });
  // Another surface is refused before any sidecar request, and a text that contains CR or LF is refused before the paste.
  await assert.rejects(inputOwnedSession({ session: "ses-1", text: "ls\r" }, "tab-other"), /^Error: session ses-1 is owned by tab-aaaaa1$/);
  await assert.rejects(readOwnedSession({ session: "ses-1" }, "tab-other"), /^Error: session ses-1 is owned by tab-aaaaa1$/);
  await assert.rejects(submitOwnedSession({ session: "ses-1", text: "ls\r" }, OWNER), /^Error: core.session.submit text must not contain CR or LF$/);
  // The owner types the text as given, submits a text as one paste and Enter, and reads the screen of the sidecar.
  assert.deepEqual(await inputOwnedSession({ session: "ses-1", text: "ls\r" }, OWNER), {});
  assert.deepEqual(await submitOwnedSession({ session: "ses-1", text: "ls" }, OWNER), {});
  assert.deepEqual(await readOwnedSession({ session: "ses-1" }, OWNER), { rows: ["$ ls", "README.md"], cursor: { row: 1, column: 0 } });
  // The sidecar reports the program state of the session to its owner; the status shows each state in turn.
  wire.deliverNotice();
  assert.deepEqual(ownedSessionsState()[0].program, { state: "working" });
  wire.deliverNotice();
  assert.deepEqual(ownedSessionsState()[0].program, { state: "idle" });
  await endOwnedSession({ session: "ses-1" }, OWNER);
  assert.deepEqual(ownedSessionsState(), []);
  await flushEvents();
  wire.finish();
});
