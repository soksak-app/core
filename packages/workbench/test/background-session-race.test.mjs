// The listener of a background session is subscribed asynchronously. A tab that closes before the subscription finished must
// still end it, or the listener stays and a later reconnection of the sidecar sends an open for a surface that no tab holds
// (F192).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const owner = "fixture-session";
const sidecar = "@scope/fixture-sidecar";

test("a background session whose tab closes before its subscription finished ends the subscription", { timeout: 5000 }, async (t) => {
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

  // The subscription of a listener finishes only when the test lets it.
  const listeners = new Map();
  const pending = [];
  const port = {
    send: () => Promise.resolve({}),
    on: (surface, listener) => new Promise((resolve) => {
      listeners.set(surface, listener);
      pending.push(() => resolve(() => { if (listeners.get(surface) === listener) listeners.delete(surface); }));
    }),
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
    surfaceForTab: (tab) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId: tab.id,
      pluginId: tab.plugin, declarations: {}, sidecars: [] }),
    placePluginPlaceholder: () => {},
  } });
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [
        { plugin: owner, title: "shown" }, { plugin: owner, title: "hidden" }] }],
    } } }),
    pluginUnits: () => [{ id: owner, name: "Session", description: "검사용 세션 표면.", surface: true, sections: [] }],
  } });
  registerPlugin({ id: owner, name: "Session", mark: "s", svg: "<path/>", ink: null, drop: null,
    background: { sidecar, operation: "open" },
    surface: (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId: owner,
      declarations: {}, sidecars: [] }) });

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    plane.onLayout((made, draw) => draw());
    plane.adopt(plane.fresh());
    const hidden = plane.currentGrid().card("main").data.tabs[1].id;
    assert.ok(listeners.has(hidden), "the tab without a surface got no background session");
    // The tab closes while the subscription of its listener has not finished.
    await plane.closeTabById(hidden);
    for (const finish of pending.splice(0)) finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!listeners.has(hidden), `the listener of the closed tab ${hidden} stayed subscribed`);
    assert.deepEqual(reports, []);
  } finally {
    plane.clear?.();
  }
});
