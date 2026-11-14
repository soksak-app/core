// core.sidebar.section.fold, core.sidebar.section.select and core.sidebar.section.size change the slots of the section surfaces: a folded section and the section of
// an unselected tab are hidden, and the other sections take its room. The commands lay out the plane again, so the compositor publishes
// the new seats and the host hides the view of the hidden section (docs/spec/plugins.md#sections).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("folding, selecting and sizing a section lay out the plane again", { timeout: 5000 }, async () => {
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
  // The plane aligns itself to the device pixel grid of this scale on every draw (device-grid.js), and JSDOM computes no layout.
  globalThis.devicePixelRatio = 2;
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  // The environment of the page: one card with a tab of an installed plugin. The sections of the sidebars belong to another plugin.
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "fixture-choice", title: "main" }] }],
    } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: "fixture-choice", package: "@fixture/choice", version: "0.0.1", manifest: {
    id: "fixture-choice", name: "Fixture", description: "검사용 표면.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
  } }] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { registerPlugin, registerSection } = await import("../registry.js");
  const sections = await import("../sidebar-sections.js");
  // The sections mount through the real compositor and surface modules. Without a host, a section surface draws its placeholder.
  registerPlugin({ id: "probe", name: "Probe", mark: "p", svg: "<path/>", ink: null, drop: null, background: null, surface: () => null });
  const surface = (surfaceId, section) => ({ composition: { kind: "view", page: "ui/section.html" }, surfaceId, pluginId: "probe",
    declarations: {}, sidecars: [], diagnostics: null, unload: false, params: null, section });
  registerSection({ id: "fixture.marks", name: "표시", height: "fill", plugin: "probe", surface });
  registerSection({ id: "fixture.notes", name: "메모", height: 80, plugin: "probe", surface });
  registerSection({ id: "fixture.list", name: "목록", height: "fill", plugin: "probe", surface });
  registerSection({ id: "fixture.tree", name: "트리", height: "fill", plugin: "probe", surface });
  const list = document.createElement("div");
  const tabs = document.createElement("div");
  list.className = "set";
  tabs.className = "set";
  document.body.append(list, tabs);
  const context = { orientation: "vertical", card: null, surface: null, space: "spc-aaaaaa" };
  const plane = await import("../plane.js");
  // Each layout of the plane records the choices of the sidebars that it finds, so the order of the change and of the layout shows.
  const layouts = [];
  const choices = () => {
    const all = sections.sidebarChoices();
    return { list: all["fixture-list"], tabs: all["fixture-tabs"] };
  };
  try {
    plane.onLayout((made, draw) => { layouts.push(choices()); draw(); });
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    // The adoption of the plane resets the choices of the sidebars, so the sets are drawn after it: a set of the tabs layout selects its first section.
    sections.drawSet(list, "fixture-list", { id: "set-l", title: "L", sections: ["fixture.marks", "fixture.notes"], layout: "list" }, context);
    sections.drawSet(tabs, "fixture-tabs", { id: "set-t", title: "T", sections: ["fixture.list", "fixture.tree"], layout: "tabs" }, context);
    layouts.length = 0;
    const { installCoreExposure } = await import("../core-exposure.js");
    await installCoreExposure({
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
    });
    await registry.run("core.sidebar.section.fold", { sidebar: "fixture-list", section: "fixture.marks" });
    await registry.run("core.sidebar.section.select", { sidebar: "fixture-tabs", section: "fixture.tree" });
    await registry.run("core.sidebar.section.size", { sidebar: "fixture-list", section: "fixture.marks", height: 200 });
    const folded = { tab: null, folded: ["fixture.marks"] };
    assert.deepEqual(layouts, [
      { list: folded, tabs: { tab: "fixture.list", folded: [] } },
      { list: folded, tabs: { tab: "fixture.tree", folded: [] } },
      { list: { ...folded, sizes: { "fixture.marks": 200 } }, tabs: { tab: "fixture.tree", folded: [] } },
    ], "a section choice did not lay out the plane again");
  } finally {
    plane.clear?.();
    dom.window.close();
  }
});
