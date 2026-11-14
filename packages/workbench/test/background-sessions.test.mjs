// A background session keeps the sidecar session of a tab that has no mounted surface (docs/spec/plugins.md). A tab whose
// surface stays mounted while another tab of its card is shown already owns its session with its image region, so a background
// `open` for it is a second owner of the same surface: the terminal sidecar then fed the output of that terminal without drawing
// it (F192). Each decision of a background session is the event `workbench.background.session`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const owner = "fixture-session";
const other = "fixture-document";
const sidecar = "@scope/fixture-sidecar";
// The stored settings store the decision of a background session, an event of the class lifecycle, at the level info.
const COMMON = { "diagnostics.log": { lifecycle: "info" } };
// The stored layout of the space of the project: one card with two tabs of the plugin that declares the background session; the first is shown.
const STORED_LAYOUT = {
  state: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, data: {
    tabs: [{ id: "tab-aaaaaa", plugin: owner, title: "shown", origin: { directory: "/work/session" } },
    { id: "tab-bbbbbb", plugin: owner, title: "hidden", origin: { directory: "/work/session" } }], activeId: "tab-aaaaaa" } }] },
  focusedId: "main", windowSidebars: {}, named: 0, sidebars: {},
};
// The replies of the host settle in the turns that follow the call.
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a background session opens only for a tab without a mounted surface and ends when its surface mounts", { timeout: 5000 }, async () => {
  // The host calls and events of the page are answered by the page-wire case of this test (docs/spec/cases/page-wire/README.md). The case is
  // selected before the modules that read the host are imported.
  const wire = selectPageWire("background-sessions-context");
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/?project=prj-session", pretendToBeVisual: true });
  // matchMedia, which JSDOM does not have. The view uses it only to subscribe to resolution changes.
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;
  globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
  globalThis.ErrorEvent = dom.window.ErrorEvent;
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

  // One card with two tabs of the plugin that declares the background session; the first is shown.
  const { installEnvironment } = await import("../environment.js");
  const surface = { composition: { kind: "view", page: "ui/index.html" } };
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [
        { plugin: owner, title: "shown" }, { plugin: owner, title: "hidden" }] }],
    } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [
    { id: owner, package: "@scope/fixture-session", version: "0.0.1", manifest: {
      id: owner, name: "Session", description: "검사용 세션 표면.", mark: "s", icon: "<path/>", surface,
      dependencies: { [sidecar]: "0.0.1" }, background: { sidecar, operation: "open" } } },
    { id: other, package: "@scope/fixture-document", version: "0.0.1", manifest: {
      id: other, name: "Document", description: "검사용 문서 표면.", mark: "d", icon: "<path/>", surface } },
  ] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { flushEvents, recordWorkbenchStart } = await import("../page-log.js");
  const projects = await import("../projects.js");
  const { HostWorkspaceStore } = await import("../host-store.js");
  const { connectSettings } = await import("../settings.js");
  const { host } = await import("@soksak/runtime");
  const compositor = await import("../compositor.js");
  const modules = await import("../surface-modules.js");
  const { createPageLayout, createErrorDisplay, createErrorWithdrawal } = await import("../page-layout.js");
  const { checkStoredLayout } = await import("../stored-layout.js");
  const { value } = await import("../settings.js");
  const { log, surfaces } = await import("../host.js");
  const plane = await import("../plane.js");
  // The page layout and the project switch are connected as index.html connects them.
  let presented = Promise.resolve();
  plane.onRender(() => { presented = Promise.resolve(compositor.publish()); });
  const pageLayout = createPageLayout({
    document, showError: createErrorDisplay({ document, changed: () => {} }), withdrawError: createErrorWithdrawal({ document, changed: () => {} }),
    setVerify: () => {}, log, surfaces,
    plane: { currentGrid: plane.currentGrid, settle: plane.settle, clear: plane.clear },
    compositor: { publishAhead: compositor.publishAhead, publish: compositor.publish, cancelPrepared: compositor.cancelPrepared },
    textSize: () => value("textSize"), rendered: () => presented,
    waitSurfaceCompositionAnswered: modules.waitSurfaceCompositionAnswered, surfaceUnloaded: () => false,
  });
  plane.onLayout((made, draw, seated, titlebar, held) => { draw(); });
  const connect = (target) => projects.onSwitch({ check: checkStoredLayout, save: target.capture, load: target.adopt, update: target.settle,
    retain: (surfaceIds) => modules.disposeSurfacesExcept(surfaceIds), presented: pageLayout.presented, empty: pageLayout.empty,
    settleTabs: target.settleModifiedTabsToClose });
  connect(plane);
  /** The background decisions of a tab that the page wrote in its log batches, as `<action>:<surface>`. */
  const decisions = async (tab) => {
    await flushEvents();
    return wire.calls.filter(({ name, payload }) => name === "log" && payload?.action === "batch")
      .flatMap(({ payload }) => payload.events)
      .filter((event) => event.event === "workbench.background.session" && event.fields.tab === tab)
      .map((event) => `${event.fields.action}:${event.fields.surface}`);
  };
  const opens = (tab) => wire.calls.filter(({ name, payload }) => name === "sidecarSend" && payload.surface === tab && payload.body.operation === "open");
  const errors = async () => {
    await flushEvents();
    return wire.calls.filter(({ name, payload }) => name === "log" && payload?.action === "batch")
      .flatMap(({ payload }) => payload.events).filter(({ level }) => level === "warn" || level === "error");
  };
  const layoutOf = (id) => ({ id, title: "session", root: "/work/session", color: "#fff", named: 1, activeSpaceId: "spc-aaaaaa",
    spaces: [{ id: "spc-aaaaaa", title: "SPACE1", layout: STORED_LAYOUT }], settings: {} });
  // The start of the document is the first event that leaves the log; its flush anchors the clock of the page with the host, so the later
  // calls of the page follow it in a fixed order.
  recordWorkbenchStart(location, performance.timeOrigin);
  await flushEvents();
  try {
    // The window starts with a project in its address: the first screen draws its layout before the project context is committed.
    projects.begin({ common: COMMON, projects: [layoutOf("prj-session")], open: [] });
    const [shown, hidden] = ["tab-aaaaaa", "tab-bbbbbb"];
    await settled();
    assert.equal(projects.initialProjectContextReady(), false, "the project context was committed before the activation");
    assert.deepEqual(wire.calls.filter(({ name }) => name === "sidecarSend"), [], "the preview opened a background session before the project context was committed");
    const store = new HostWorkspaceStore(host);
    await connectSettings(store);
    await projects.initialise(store, () => false);
    await settled();
    assert.ok(modules.mountedSurface(shown), "the first draw did not mount the shown tab");
    // After the project context commits, the hidden tab has no surface and gets its background session.
    assert.equal(opens(hidden).length, 1, "the tab without a surface got no background open");
    assert.deepEqual(await decisions(hidden), ["open:absent"]);
    // The calls of the page that open a session, with the steps of the test between them: a send that a step causes comes after the mark of that step.
    const marks = [];
    const step = (label) => marks.push([label, wire.calls.length]);

    // A tab of another plugin is shown in the card. The surface of the first tab stays mounted and keeps its session.
    step("added");
    plane.addTabTo("main", other);
    await settled();
    assert.ok(modules.mountedSurface(shown), "the surface of the hidden tab was released");
    assert.equal(opens(shown).length, 0, `a background open was sent for the mounted surface ${shown}`);
    assert.deepEqual(await decisions(shown), ["skip:mounted"]);

    // The tab that had a background session is shown: its surface mounts and owns the session from then on.
    step("selected");
    plane.selectTab(hidden);
    await settled();
    assert.ok(modules.mountedSurface(hidden), "selecting the tab did not mount its surface");
    assert.deepEqual(await decisions(hidden), ["open:absent", "stop:mounted"]);
    // The session of the tab ended, so the page does not listen to the messages of the sidecar for it any more: a respawned service
    // announces its new connection only to a listener, and the page has none for this tab, so only a background session could reopen.
    step("reconnected");
    assert.deepEqual(wire.calls.filter(({ name, payload }) => name === "sidecarListen" && payload.id === hidden).map(({ payload }) => payload.on), [true, false],
      "the page kept listening to the sidecar messages of the tab whose session ended");
    assert.equal(opens(hidden).length, 1, `the shown tab ${hidden} got a background open after the reconnection`);
    assert.deepEqual(await errors(), []);

    // A failed page initialization rejects the pending observer once. Later redraws must not start sessions or report it again.
    plane.clear();
    await modules.disposeSurfacesExcept(new Set());
    const failedContextPlane = await import("../plane.js?failed-initial-project-context");
    failedContextPlane.onLayout((made, draw) => { draw(); });
    connect(failedContextPlane);
    const beforeFailedContext = wire.calls.filter(({ name }) => name === "sidecarSend").length;
    projects.begin({ common: COMMON, projects: [layoutOf("prj-session")], open: [] });
    await settled();
    assert.equal(projects.initialProjectContextReady(), false, "the project context was committed before the activation failed");
    assert.equal(wire.calls.filter(({ name }) => name === "sidecarSend").length, beforeFailedContext, "a preview opened a background session while failed initialization was still pending");
    step("rejected");
    await assert.rejects(projects.initialise(store, () => false), /tab-state store open failed/);
    assert.equal(projects.initialProjectContextFailed(), true);
    await settled();
    failedContextPlane.settle();
    await settled();
    assert.equal(wire.calls.filter(({ name }) => name === "sidecarSend").length, beforeFailedContext, "a later redraw opened a background session after startup context failure");
    assert.deepEqual(await errors(), [], "the background observer duplicated the initialization error report");
    failedContextPlane.clear();
    // No send came after a step that could not cause it, and the opens of the mounted surface never came at all.
    const order = [...marks, ...wire.calls.map((call, index) => (call.name === "sidecarSend" && call.payload.body.operation === "open" ? [`open ${call.payload.surface}`, index] : null)).filter(Boolean)]
      .toSorted((a, b) => a[1] - b[1]).map(([label]) => label);
    assert.deepEqual(order, [`open ${hidden}`, "added", "selected", "reconnected", "rejected"],
      "a background open came out of order or for a surface that holds its own session");
  } finally {
    plane.clear();
  }
  await settled();
  await flushEvents();
  wire.finish();
});
