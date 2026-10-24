// A background session keeps the sidecar session of a tab that has no mounted surface (docs/spec/plugins.md). A tab whose
// surface stays mounted while another tab of its card is shown already owns its session with its image region, so a background
// `open` for it is a second owner of the same surface: the terminal sidecar then fed the output of that terminal without drawing
// it (F192). Each decision of a background session is the event `page.background.session`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const owner = "fixture-session";
const other = "fixture-document";
const sidecar = "@scope/fixture-sidecar";

test("a background session opens only for a tab without a mounted surface and ends when its surface mounts", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  // matchMedia, which JSDOM does not have. The view uses it only to subscribe to resolution changes.
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
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

  // The sidecar port of the window: the test records each send and keeps the listener of each surface, so it can deliver the
  // notice of a new connection that the host sends after the persistent service was respawned.
  const sends = [];
  const listeners = new Map();
  const port = {
    send: (surface, body) => { sends.push({ surface, body }); return Promise.resolve({}); },
    on: (surface, listener) => {
      listeners.set(surface, listener);
      return Promise.resolve(() => { if (listeners.get(surface) === listener) listeners.delete(surface); });
    },
  };
  const reports = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, native: true, report: (line) => reports.push(line),
    windowSidecar: (name) => (name === sidecar ? port : null) } });
  const events = [];
  const actualLog = await import("../page-log.js");
  t.mock.module("../page-log.js", { exports: { ...actualLog,
    emitEvent: (level, event, fields) => events.push({ level, event, fields }) } });
  // The surfaces that are mounted. A surface stays mounted while another tab of its card is shown: it is held, not disposed.
  const mounted = new Set();
  t.mock.module("../surface-modules.js", { exports: {
    mountSurface: (slot, surface) => { mounted.add(surface.surfaceId); return Promise.resolve(); },
    disposeSurface: (id) => { mounted.delete(id); return Promise.resolve(); },
    mountedSurface: (id) => (mounted.has(id) ? { surfaceId: id } : null),
    placePluginPlaceholder: () => {},
    surfaceForTab: (tab) => surfaceOf(tab.plugin)(tab.id),
  } });
  let commitProjectContext;
  let rejectProjectContext;
  let projectContextReady = false;
  let projectContextFailed = false;
  let projectContext = new Promise((resolve) => { commitProjectContext = resolve; });
  t.mock.module("../projects.js", { exports: {
    initialProjectContextReady: () => projectContextReady,
    initialProjectContextFailed: () => projectContextFailed,
    waitForInitialProjectContext: () => projectContext,
  } });
  // One card with two tabs of the plugin that declares the background session; the first is shown.
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [
        { plugin: owner, title: "shown" }, { plugin: owner, title: "hidden" }] }],
    } } }),
    pluginUnits: () => [
      { id: owner, name: "Session", description: "검사용 세션 표면.", surface: true, sections: [] },
      { id: other, name: "Document", description: "검사용 문서 표면.", surface: true, sections: [] },
    ],
  } });
  const surfaceOf = (pluginId) => (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId,
    declarations: {}, sidecars: [] });
  registerPlugin({ id: owner, name: "Session", mark: "s", svg: "<path/>", ink: null, drop: null,
    background: { sidecar, operation: "open" }, surface: surfaceOf(owner) });
  registerPlugin({ id: other, name: "Document", mark: "d", svg: "<path/>", ink: null, drop: null, background: null,
    surface: surfaceOf(other) });

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const decisions = (tab) => events.filter((e) => e.event === "page.background.session" && e.fields.tab === tab)
    .map((e) => `${e.fields.action}:${e.fields.surface}`);
  const opens = (tab) => sends.filter((s) => s.surface === tab && s.body.operation === "open").length;
  try {
    plane.onLayout((made, draw) => draw());
    plane.adopt(plane.fresh());
    const [shown, hidden] = plane.currentGrid().card("main").data.tabs.map((tab) => tab.id);
    assert.ok(mounted.has(shown), "the first draw did not mount the shown tab");
    assert.equal(sends.length, 0, "the preview opened a background session before the project context was committed");
    projectContextReady = true;
    commitProjectContext();
    await new Promise((resolve) => setImmediate(resolve));
    // After projectShown commits, the hidden tab has no surface and gets its background session.
    assert.equal(opens(hidden), 1, "the tab without a surface got no background open");
    assert.deepEqual(decisions(hidden), ["open:absent"]);

    // A tab of another plugin is shown in the card. The surface of the first tab stays mounted and keeps its session.
    plane.addTabTo("main", other);
    assert.ok(mounted.has(shown), "the surface of the hidden tab was released");
    assert.equal(opens(shown), 0, `a background open was sent for the mounted surface ${shown}`);
    assert.deepEqual(decisions(shown), ["skip:mounted"]);

    // The tab that had a background session is shown: its surface mounts and owns the session from then on.
    plane.selectTab(hidden);
    assert.ok(mounted.has(hidden), "selecting the tab did not mount its surface");
    assert.deepEqual(decisions(hidden), ["open:absent", "stop:mounted"]);
    // A respawned service announces the new connection; only a background session reopens, and this tab has none any more.
    listeners.get(hidden)?.({ event: "connection", connected: true });
    assert.equal(opens(hidden), 1, `the shown tab ${hidden} got a background open after the reconnection`);
    assert.deepEqual(reports, []);

    // A failed page initialization rejects the pending observer once. Later redraws must not start sessions or report it again.
    projectContextReady = false;
    projectContextFailed = false;
    projectContext = new Promise((_resolve, reject) => { rejectProjectContext = reject; });
    plane.clear?.();
    mounted.clear();
    const failedContextPlane = await import("../plane.js?failed-initial-project-context");
    failedContextPlane.onLayout((made, draw) => draw());
    const beforeFailedContext = sends.length;
    failedContextPlane.adopt(failedContextPlane.fresh());
    assert.equal(sends.length, beforeFailedContext, "a preview opened a background session while failed initialization was still pending");
    projectContextFailed = true;
    rejectProjectContext(new Error("initial project context failed"));
    await new Promise((resolve) => setImmediate(resolve));
    failedContextPlane.settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sends.length, beforeFailedContext, "a later redraw opened a background session after startup context failure");
    assert.deepEqual(reports, [], "the background observer duplicated the initialization error report");
    failedContextPlane.clear?.();
  } finally {
    plane.clear?.();
  }
});
