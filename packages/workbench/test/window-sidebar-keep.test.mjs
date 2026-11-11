// A window sidebar that its switch hides keeps its section surfaces as hidden surfaces: their slots stay in the plane, hidden, so the
// commit keeps their views and a show places them again without a new view; an arrangement keeps the slots of the sidebar that stays
// (docs/spec/plugins.md#sections, docs/spec/external-sidebars.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin, registerSection } from "../registry.js";

const pluginId = "fixture-keep";
const setId = "fixture-keep-set";
const treeId = (side) => `spc-aaaaaa/${side}/${pluginId}.tree`;

test("a switched window sidebar keeps its section surfaces hidden in the plane, and an arrangement keeps the sidebar that stays", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.devicePixelRatio = 2;
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  // The border width and the width of a collapsed sidebar that app.css gives a card; JSDOM does not load app.css.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const reports = [];
  const disposed = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, report: (line) => reports.push(line) } });
  t.mock.module("../surface-modules.js", { exports: {
    mountedSurface: () => null,
    surfaceForTab: (tab) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId: tab.id,
      pluginId: tab.plugin, declarations: {}, sidecars: [] }),
    mountSurface: () => Promise.resolve(),
    // The sidebar never ends a surface itself; a call is recorded so that the test shows it.
    disposeSurface: (id) => { disposed.push(id); return Promise.resolve(); }, placePluginPlaceholder: () => {},
  } });
  t.mock.module("../compositor.js", { exports: { ...(await import("../compositor.js")), setSlotSurface: () => {}, clearSlotSurface: () => {} } });
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", description: "검사용 표면.", surface: true, sections: [] }],
    refusedPlugins: () => new Set(),
  } });
  // The left and the right side show the same set, and their switches are the settings left and right.
  const changed = {
    sets: [{ id: setId, title: "Fixture", layout: "list", sections: [`${pluginId}.tree`] }],
    links: [{ place: "left", plugin: null, set: setId }, { place: "right", plugin: null, set: setId }],
    left: true, right: true, sidebarWidth: 120,
  };
  const actualSettings = await import("../settings.js");
  const { resolveSidebar } = await import("../sidebar-sets.js");
  t.mock.module("../settings.js", { exports: { projectSidebars: () => ({ sets: [], links: [] }), ...actualSettings,
    value: (key) => (Object.hasOwn(changed, key) ? changed[key] : actualSettings.value(key)),
    linkedSet: (place, plugin) => resolveSidebar(changed.links, changed.sets, place, plugin) } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, drop: null,
    surface: (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId,
      declarations: {}, sidecars: [] }),
  });
  const composition = { kind: "view", page: "ui/tree.html" };
  registerSection({ id: `${pluginId}.tree`, name: "Tree", composition, height: "fill", plugin: pluginId,
    surface: (surfaceId, start) => ({ composition, surfaceId, pluginId, declarations: {}, sidecars: [], diagnostics: null,
      unload: false, params: null, section: start }) });

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const { sectionSurfaceShown } = await import("../section-surfaces.js");
  const { sidebarsState } = await import("../sidebar-sections.js");
  const { audit } = await import("../commands.js");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw?.(); };
    const slotsOf = (id) => [...planeEl.querySelectorAll(`[data-native-surface][data-native-surface-id="${id}"]`)];
    const switchTo = (side, on) => { changed[side] = on; plane.settle(); drawHeld(); };
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    drawHeld();
    for (const side of ["left", "right"]) {
      assert.ok(planeEl.querySelector(`.card[data-card-id="${side}"]`), `the ${side} sidebar stands`);
      assert.equal(slotsOf(treeId(side)).length, 1, `the ${side} sidebar seats its section once`);
    }
    const leftSlot = slotsOf(treeId("left"))[0];

    // An arrangement that closes and inserts the window sidebars again keeps the slot of the sidebar that stays.
    switchTo("right", false);
    assert.equal(planeEl.querySelector('.card[data-card-id="right"]'), null, "the right sidebar left the plane");
    assert.equal(slotsOf(treeId("left"))[0], leftSlot, "the arrangement replaced the section slot of the left sidebar");
    assert.equal(leftSlot.closest("[hidden]"), null, "the section of the left sidebar stays shown");

    // The hidden sidebar keeps its section surface: a hidden slot in the plane, which the commit keeps, and core.sidebars reports
    // only the drawn sidebars.
    const hidden = slotsOf(treeId("right"));
    assert.equal(hidden.length, 1, "the switch off ended the section surface of the right sidebar");
    assert.ok(hidden[0].closest("[hidden]"), "the kept section of the hidden sidebar is not hidden");
    assert.ok(sectionSurfaceShown(treeId("right")), "the kept section is not held by a sidebar of the frame");
    assert.deepEqual(sidebarsState().map(({ sidebar }) => sidebar), ["left"], "core.sidebars reports the hidden sidebar");
    // The kept set is not drawn, so its controls are inert and the audit of the workbench lists none of them.
    assert.deepEqual(audit(document.body), [], "the audit lists the controls of the kept set");

    // A show places the kept surface in the sidebar again.
    switchTo("right", true);
    const shown = slotsOf(treeId("right"));
    assert.equal(shown.length, 1, "the show seats the section once");
    assert.ok(shown[0].closest('.card[data-card-id="right"]'), "the shown section stands outside its sidebar");
    assert.equal(shown[0].closest("[hidden]"), null, "the shown section stays hidden");
    assert.ok(sectionSurfaceShown(treeId("right")));
    assert.deepEqual(audit(document.body), [], "the audit lists a control of the shown sidebar");
    assert.deepEqual(disposed, [], "the sidebar ended a surface");
    assert.deepEqual(reports, []);
  } finally {
    delete globalThis.devicePixelRatio;
    dom.window.close();
  }
});
