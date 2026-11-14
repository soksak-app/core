// A surface whose image detach was pending when the host built the start document waits for its image-detach-ended event
// before the page places or mounts it or opens its background session; a failed detach leaves the tab unmounted with its
// error (docs/spec/sidecars.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

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

test("a held tab is neither mounted nor given a background session until its detach ends", { timeout: 5000 }, async () => {
  // The host calls of the page are answered by the page-wire case of this test (docs/spec/cases/page-wire/README.md). The case is selected
  // before the modules that read the host are imported, because they read it when they are imported.
  const wire = selectPageWire("image-detach-waits-held-tab");
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

  // The plugin of the tabs is installed through the environment module, as the page installs it at its start. Its surface is a view, and it
  // declares a background session of the sidecar.
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [
        { plugin: owner, title: "shown" }, { plugin: owner, title: "hidden" }] }],
    } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: owner, package: "@scope/fixture-session", version: "0.0.1", manifest: {
    id: owner, name: "Session", description: "검사용 세션 표면.", mark: "s", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/page.html" } },
    dependencies: { [sidecar]: "^0.1.0" },
    background: { sidecar, operation: "open" },
  } }] }), [], "the environment of the case is not loaded");

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const waits = await import("../image-detach-waits.js");
  const plane = await import("../plane.js");
  const { mountedSurface } = await import("../surface-modules.js");
  const { flushEvents } = await import("../page-log.js");
  // The open requests that the page sent to the sidecar for the surface, in the calls of its wire.
  const opens = (tab) => wire.calls.filter(({ name, payload }) => name === "sidecarSend" && payload.surface === tab && payload.body.operation === "open").length;
  try {
    plane.onLayout((made, draw) => draw());
    const fresh = plane.fresh();
    const [shown, hidden] = fresh.state.cards[0].data.tabs.map((tab) => tab.id);
    waits.holdImageDetachSurfaces([shown, hidden]);
    plane.adopt(fresh, "spc-aaaaaa");
    const slot = document.querySelector('[data-card-id="main"] .slot');
    assert.equal(mountedSurface(shown), null, "a tab whose detach is pending was mounted");
    assert.equal(slot.dataset.nativeSurfaceId, undefined, "a tab whose detach is pending was placed as a native surface");
    assert.equal(slot.dataset.surfaceStatus, "loading");
    assert.equal(opens(hidden), 0, "a tab whose detach is pending got a background open");

    assert.equal(waits.imageDetachEnded({ surface: shown, error: null }), true);
    plane.settle();
    assert.ok(mountedSurface(shown), "the end of the detach did not mount the shown tab");
    assert.equal(slot.dataset.nativeSurfaceId, shown);
    assert.equal(opens(hidden), 0, "the end of another tab opened the session of a tab still pending");

    assert.equal(waits.imageDetachEnded({ surface: hidden, error: "image detach sidecar s surface t image v generation 1 request r rejected: staleGeneration" }), true);
    plane.settle();
    assert.equal(opens(hidden), 0, "a tab whose detach failed got a background open");
    plane.selectTab(hidden);
    assert.equal(mountedSurface(hidden), null, "a tab whose detach failed was mounted");
    assert.equal(slot.dataset.surfaceStatus, "error");
    // The error display writes the failure as an error record of the page, which leaves in the log batch of the wire.
    await flushEvents();
    const lines = wire.calls
      .filter(({ name, payload }) => name === "log" && payload?.action === "batch")
      .flatMap(({ payload }) => payload.events)
      .filter((event) => event.event === "workbench.record.error")
      .map((event) => `${event.fields.where}: ${event.fields.text}`);
    assert.deepEqual(lines, [`surface status main ${hidden}: 표면 오류 · image detach sidecar s surface t image v generation 1 request r rejected: staleGeneration`],
      "the error display did not write the failure of the held tab with its surface id");
  } finally {
    plane.clear?.();
  }
  // Clearing the plane counts further events that the gate refuses; they leave in a last batch of the wire before the case ends.
  await flushEvents();
  await flushEvents();
  wire.finish();
});
