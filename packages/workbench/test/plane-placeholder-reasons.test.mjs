// The placeholder reasons missing, disabled, reload and host describe designed states of a saved layout that names a plugin that is not loaded
// (docs/spec/plugins.md#plugins-that-are-not-loaded). They are not failures, so they write no error through the error display path (F217).
// This test is a regression guard: the reason unread is the only one that shows an error, and it is tested in plane-placeholder-error.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const pluginId = "fixture-placeholder-reasons";

test("the placeholder reasons that are designed states write no error", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  // matchMedia, which JSDOM does not have. The view uses it only to subscribe to resolution changes, and this test does not change the resolution.
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  // The size of the plane. JSDOM does not compute layout, so the test gives a size that has space to split.
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  // The border width that the app stylesheet gives a card. JSDOM does not load app.css.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const reports = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, report: (line) => reports.push(line) } });
  // The calls of the error display path. A designed placeholder must not reach it.
  const errorCalls = [];
  const actualErrors = await import("../shown-errors.js");
  t.mock.module("../shown-errors.js", { exports: {
    showError: (element, where, text, detail) => {
      errorCalls.push({ kind: "show", where, text });
      return actualErrors.showError(element, where, text, detail);
    },
    hideError: (element, where) => {
      errorCalls.push({ kind: "hide", where });
      return actualErrors.hideError(element, where);
    },
  } });
  // The plugin state that each reason reads. The test changes it and then runs the listeners that the plane registered for plugin changes.
  const state = { hosted: true, rows: [] };
  const listeners = [];
  const actualInstalled = await import("../installed-plugins.js");
  t.mock.module("../installed-plugins.js", { exports: { ...actualInstalled,
    pluginOperations: { get hosted() { return state.hosted; }, failure: () => null, status: () => ({ plugins: state.rows }) },
    onPluginOperations: (fn) => { listeners.push(fn); },
  } });
  // The test does not load surface modules. The placeholder replaces the one of its tab in the slot, as the surface modules do.
  t.mock.module("../surface-modules.js", { exports: {
    mountedSurface: () => null,
    mountSurface: () => Promise.resolve(),
    disposeSurface: () => Promise.resolve(), focusSurface: () => true,
    placePluginPlaceholder: (slot, surfaceId, element) => {
      for (const old of slot.querySelectorAll("[data-plugin-placeholder]")) old.remove();
      slot.append(element);
    },
  } });
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "gone" }] }],
    } } }),
    pluginUnits: () => [],
  } });

  // The card elements connect only to declared core commands.
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw(); };
    plane.adopt(plane.fresh());
    drawHeld();
    const cases = [
      { reason: "missing", set: () => { state.hosted = true; state.rows = []; } },
      { reason: "disabled", set: () => { state.hosted = true; state.rows = [{ id: pluginId, installed: { enabled: false } }]; } },
      { reason: "reload", set: () => { state.hosted = true; state.rows = [{ id: pluginId, installed: { enabled: true } }]; } },
      { reason: "host", set: () => { state.hosted = false; state.rows = []; } },
    ];
    for (const { reason, set } of cases) {
      set();
      for (const listener of listeners) listener();
      drawHeld();
      const line = document.querySelector(`[data-plugin-placeholder="${reason}"] p`);
      assert.ok(line?.textContent, `the ${reason} placeholder is not drawn`);
      assert.equal(line.dataset.error, undefined, `the ${reason} placeholder is marked as an error`);
    }
    // The surface status row also withdraws its own error on every state, so only the show calls and the placeholder places are judged.
    assert.deepEqual(errorCalls.filter((call) => call.kind === "show"), [], "a designed placeholder reason reached the error display path");
    assert.deepEqual(errorCalls.filter((call) => call.where?.endsWith(" placeholder")), [], "a designed placeholder reason withdrew a placeholder place");
    assert.deepEqual(reports, [], "a designed placeholder reason wrote an error to the application log");
  } finally {
    dom.window.close();
  }
});
