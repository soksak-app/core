// core.tab.close waits for the drawing of the plane after the tab close finishes. A tab close removes the tab from the plane and schedules a new layout; the surface is released by the commit of that layout.
// If the command answers before the tab close, the drawing wait of the command reads the slot before the removal, and the drawing wait of the next command that the test sends
// reads a slot that still has the removed surface by name and fails with `surface … is not mounted` (F50).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const pluginId = "fixture-tab-close";

test("core.tab.close answers after the tab close and its draw", { timeout: 5000 }, async () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
  // The size of the plane and the border width that app.css gives a card; JSDOM computes no layout and loads no stylesheet.
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  // The environment of the page: one card with two tabs of the plugin.
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
      { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "first" }, { plugin: pluginId, title: "second" }] },
    ] } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: pluginId, package: "@fixture/tab-close", version: "0.0.1", manifest: {
    id: pluginId, name: "Fixture", description: "Fixture surface.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
  } }] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const { installCoreExposure } = await import("../core-exposure.js");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    held();
    held = null;
    const tabs = () => plane.currentGrid().card("main").data.tabs.map(({ id }) => id);
    const [closing, staying] = tabs();
    // The order of the command: the tab is removed before the drawing wait starts, and the command answers after the drawing wait.
    const events = [];
    await installCoreExposure({
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null,
      drawn: async () => { events.push(`settled, tabs ${tabs().join(",")}, layout ${held === null ? "not scheduled" : "scheduled"}`); },
    });
    const answer = registry.run("core.tab.close", { tab: closing }).then((result) => { events.push("answered"); return result; });
    events.push("requested");
    assert.deepEqual(await answer, { closed: true });
    assert.deepEqual(events, ["requested", `settled, tabs ${staying}, layout scheduled`, "answered"],
      "the command drew or answered before the tab close finished");
  } finally {
    delete globalThis.devicePixelRatio;
    dom.window.close();
  }
});
