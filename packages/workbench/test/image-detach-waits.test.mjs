// A surface whose image detach was pending when the host built the start document waits for its image-detach-ended event
// before the page places or mounts it or opens its background session; a failed detach leaves the tab unmounted with its
// error (docs/spec/sidecars.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const owner = "fixture-session";
const sidecar = "@scope/fixture-sidecar";

test("the hold of a surface follows the start document and its image-detach-ended event", { timeout: 5000 }, async () => {
  const waits = await import("../image-detach-waits.js?hold");
  assert.throws(() => waits.holdImageDetachSurfaces(undefined), /pendingSurfaces must be an array of surface ids, not undefined/);
  assert.throws(() => waits.holdImageDetachSurfaces([""]), /pendingSurfaces must be an array of surface ids/);
  waits.holdImageDetachSurfaces(["tab-a", "tab-b"]);
  assert.equal(waits.imageDetachHold("tab-a"), "waiting");
  assert.equal(waits.imageDetachHold("tab-c"), null);
  assert.throws(() => waits.imageDetachEnded({ surface: "tab-a" }), /invalid image-detach-ended event/);
  assert.equal(waits.imageDetachEnded({ surface: "tab-c", error: null }), false, "an end of a surface outside the list released it");
  assert.equal(waits.imageDetachEnded({ surface: "tab-a", error: null }), true);
  assert.equal(waits.imageDetachHold("tab-a"), null);
  assert.equal(waits.imageDetachEnded({ surface: "tab-b", error: "image detach rejected" }), true);
  assert.deepEqual(waits.imageDetachHold("tab-b"), { error: "image detach rejected" });
  assert.equal(waits.imageDetachEnded({ surface: "tab-b", error: null }), false, "a second end changed a failed surface");
});

test("a held tab is neither mounted nor given a background session until its detach ends", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
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

  const sends = [];
  const port = {
    send: (surface, body) => { sends.push({ surface, body }); return Promise.resolve({}); },
    on: () => Promise.resolve(() => {}),
  };
  const reports = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, native: true, report: (line) => reports.push(line),
    windowSidecar: (name) => (name === sidecar ? port : null) } });
  const mounted = new Set();
  t.mock.module("../surface-modules.js", { exports: {
    mountSurface: (slot, surface) => { mounted.add(surface.surfaceId); return Promise.resolve(); },
    disposeSurface: (id) => { mounted.delete(id); return Promise.resolve(); },
    mountedSurface: (id) => (mounted.has(id) ? { surfaceId: id } : null),
    placePluginPlaceholder: () => {},
    surfaceForTab: (tab) => surfaceOf(tab.id),
  } });
  t.mock.module("../projects.js", { exports: {
    initialProjectContextReady: () => true,
    initialProjectContextFailed: () => false,
    waitForInitialProjectContext: () => Promise.resolve(),
    storedTabTaken: () => false,
  } });
  t.mock.module("../environment.js", { exports: { refusedPlugins: () => new Set(),
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [
        { plugin: owner, title: "shown" }, { plugin: owner, title: "hidden" }] }],
    } } }),
    pluginUnits: () => [{ id: owner, name: "Session", description: "검사용 세션 표면.", surface: true, sections: [] }],
  } });
  const surfaceOf = (surfaceId) => ({ module: "/fixture.js", composition: { kind: "view" }, surfaceId, pluginId: owner,
    declarations: {}, sidecars: [] });
  registerPlugin({ id: owner, name: "Session", mark: "s", svg: "<path/>", ink: null, drop: null,
    background: { sidecar, operation: "open" }, surface: surfaceOf });

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const waits = await import("../image-detach-waits.js");
  const plane = await import("../plane.js");
  const opens = (tab) => sends.filter((s) => s.surface === tab && s.body.operation === "open").length;
  try {
    plane.onLayout((made, draw) => draw());
    const fresh = plane.fresh();
    const [shown, hidden] = fresh.state.cards[0].data.tabs.map((tab) => tab.id);
    waits.holdImageDetachSurfaces([shown, hidden]);
    plane.adopt(fresh);
    await new Promise((resolve) => setImmediate(resolve));
    const slot = document.querySelector('[data-card-id="main"] .slot');
    assert.equal(mounted.has(shown), false, "a tab whose detach is pending was mounted");
    assert.equal(slot.dataset.nativeSurfaceId, undefined, "a tab whose detach is pending was placed as a native surface");
    assert.equal(slot.dataset.surfaceStatus, "loading");
    assert.equal(opens(hidden), 0, "a tab whose detach is pending got a background open");

    assert.equal(waits.imageDetachEnded({ surface: shown, error: null }), true);
    plane.settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(mounted.has(shown), "the end of the detach did not mount the shown tab");
    assert.equal(slot.dataset.nativeSurfaceId, shown);
    assert.equal(opens(hidden), 0, "the end of another tab opened the session of a tab still pending");

    assert.equal(waits.imageDetachEnded({ surface: hidden, error: "image detach sidecar s surface t image v generation 1 request r rejected: staleGeneration" }), true);
    plane.settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opens(hidden), 0, "a tab whose detach failed got a background open");
    plane.selectTab(hidden);
    assert.equal(mounted.has(hidden), false, "a tab whose detach failed was mounted");
    assert.equal(slot.dataset.surfaceStatus, "error");
    assert.deepEqual(reports, [`surface status main ${hidden}: 표면 오류 · image detach sidecar s surface t image v generation 1 request r rejected: staleGeneration`],
      "the error display did not write the failure of the held tab with its surface id");
  } finally {
    plane.clear?.();
  }
});
