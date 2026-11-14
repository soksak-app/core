// The listener of a background session is subscribed asynchronously. A tab that closes before the subscription finished must
// still end it, or the listener stays and a later reconnection of the sidecar sends an open for a surface that no tab holds
// (F192). The host calls of the page are answered by the page-wire case of this test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const owner = "fixture-session";
const sidecar = "@scope/fixture-sidecar";
const settled = () => new Promise((resolve) => setImmediate(resolve));
// The sidecar calls of the page, as [name, id, on]; the other calls of the page belong to its start and to its log.
const listenCalls = (wire) => wire.calls.filter(({ name }) => name === "sidecarListen" || name === "sidecarSend")
  .map(({ name, payload }) => [name, payload.id, payload.on]);

test("a background session whose tab closes before its subscription finished ends the subscription", { timeout: 5000 }, async () => {
  // The case is selected before the modules that read the host are imported.
  const wire = selectPageWire("background-session-race-subscription");
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

  // One card with two tabs of the plugin that declares the background session; the first is shown, so the second has no surface.
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
    surface: { composition: { kind: "view", page: "ui/index.html" } },
    dependencies: { [sidecar]: "0.0.1" },
    background: { sidecar, operation: "open" },
  } }] }), [], "the fixture environment refused a plugin");

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { flushEvents } = await import("../page-log.js");
  const plane = await import("../plane.js");
  try {
    plane.onLayout((made, draw) => draw());
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    const hidden = plane.currentGrid().card("main").data.tabs[1].id;
    await settled();
    // The host delivers the reply of the open only to a registered listener, so the open waits for the subscription
    // (docs/spec/sidecars.md#page-interface). The subscription finishes when the test releases the reply of the host.
    assert.deepEqual(listenCalls(wire), [["sidecarListen", hidden, true]],
      "the tab without a surface got no background session");
    // The tab closes while the subscription of its listener has not finished.
    await plane.closeTabById(hidden);
    wire.release();
    await settled();
    assert.deepEqual(listenCalls(wire),
      [["sidecarListen", hidden, true], ["sidecarListen", hidden, false]],
      `the listener of the closed tab ${hidden} stayed subscribed`);
    assert.ok(!wire.calls.some(({ name }) => name === "sidecarSend"), "a background session sent its open before or after its subscription finished");
    await flushEvents();
    // The page reports an error as an event of the level warn or error in a batch of its log (docs/spec/logging.md#entrances).
    assert.deepEqual(wire.calls.filter(({ name, payload }) => name === "log" && payload.action === "batch")
      .flatMap(({ payload }) => payload.events).filter(({ level }) => level === "warn" || level === "error"), []);
  } finally {
    plane.clear?.();
  }
  wire.finish();
});
