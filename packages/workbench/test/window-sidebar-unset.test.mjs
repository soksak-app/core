// A window sidebar that its side holds through a plugin window link while the focused card belongs to another plugin shows no set: it
// draws its status line, and core.sidebars reports it with its rectangle and a null set
// (docs/spec/external-sidebars.md#override-context-and-rail-border).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { drained } from "./support/drained.mjs";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const pluginId = "fixture-unset";
const otherId = "fixture-other";
const setId = "fixture-unset-set";

const wire = selectPageWire("window-sidebar-unset-session");

test("core.sidebars reports a window sidebar that shows no set with its rectangle and a null set", { timeout: 5000 }, async () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  Object.defineProperty(document, "adoptedStyleSheets", { value: [] });
  globalThis.devicePixelRatio = 2;
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  // The border width and the width of a collapsed sidebar that app.css gives a card; JSDOM does not load app.css.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);
  // JSDOM lays out nothing, so the set of a sidebar takes the rectangle of the card that holds it.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function rect() {
    const card = this.closest(".card");
    const box = card ? { x: 10, y: 20, width: 120, height: 300 } : { x: 0, y: 0, width: 0, height: 0 };
    return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
  };

  // The tab plugin, and the plugin whose window link gives the top side its sidebar.
  const manifest = (id) => ({ id, name: id, description: "검사용 표면.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
    sections: [{ id: `${id}.tree`, name: "Tree", height: "fill", composition: { kind: "view", page: "ui/tree.html" } }] });
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      root: { card: "main", tabs: [{ plugin: pluginId, title: "main" }] },
    } },
    sidebars: {
      sets: [{ id: setId, title: "Fixture", layout: "list", sections: [`${otherId}.tree`] }],
      links: [{ place: "window-top", plugin: otherId, set: setId }],
    },
  }, { plugins: [pluginId, otherId].map((id) => ({ id, package: `@fixture/${id}`, version: "0.0.1", folder: "/installed/plugin", manifest: manifest(id) })) }), [],
  "the fixture environment refused a plugin");
  const { beginSettings } = await import("../settings.js");
  beginSettings({ common: { top: true, sidebarWidth: 120 }, projects: [] }, null);

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const { sidebarsState } = await import("../sidebar-sections.js");
  const { flushEvents } = await import("../page-log.js");
  const errorRecords = () => wire.calls.filter(({ name, payload }) => name === "log" && payload.action === "batch")
    .flatMap(({ payload }) => payload.events).filter(({ event }) => event === "workbench.record.error");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    held?.();
    const top = planeEl.querySelector('.card[data-card-id="top"]');
    assert.ok(top, "the top sidebar stands");
    // Without a set the head shows the side name and no layout badge (docs/spec/external-sidebars.md#sidebar-head-and-edge).
    assert.equal(top.querySelector(".sidebar-head__name").textContent, "위", "the head of the top sidebar does not show the side name");
    assert.equal(top.querySelector(".sidebar-head__layout").textContent, "", "the head of a sidebar without a set shows a layout badge");
    const reported = sidebarsState().find((entry) => entry.sidebar === "top");
    assert.ok(reported, `core.sidebars omits the drawn top sidebar: ${JSON.stringify(sidebarsState())}`);
    assert.deepEqual(reported, {
      sidebar: "top", set: null, layout: null, orientation: "horizontal", tab: null, card: null, surface: null, placement: "window",
      plugin: null, side: "top", rect: { x: 10, y: 20, w: 120, h: 300 }, sections: [],
    });
    const { sidebarChoices } = await import("../sidebar-sections.js");
    assert.equal(Object.hasOwn(sidebarChoices(), "top"), false, "the report of a sidebar without a set made a choice that the space stores");
    await drained();
    await flushEvents();
    assert.deepEqual(errorRecords(), []);
    wire.finish();
  } finally {
    delete globalThis.devicePixelRatio;
    dom.window.close();
  }
});
