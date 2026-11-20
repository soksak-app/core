// The page of the layout change tests: the workbench document with the core exposure of the page, a policy that stores the class
// call at the level debug, and the group card-3 of card-1 beside card-2 (docs/spec/events.json, workbench.layout.change).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

export const PLAIN = "fixture-plain";

/**
 * Opens the page with the page-wire case caseName, which answers the calls of the event writer (docs/spec/cases/page-wire/README.md);
 * the case is selected before the modules that read the host are imported. Returns the wire, the registry, the plane and flushEvents.
 */
export async function openLayoutChangePage(caseName) {
  const dom = new JSDOM(readFileSync(new URL("../../index.html", import.meta.url), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), CSS: dom.window.CSS, PointerEvent: dom.window.PointerEvent,
    MouseEvent: dom.window.MouseEvent, addEventListener: dom.window.addEventListener.bind(dom.window),
    devicePixelRatio: dom.window.devicePixelRatio })) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const planeElement = document.getElementById("plane");
  Object.defineProperty(planeElement, "clientWidth", { value: 1600 });
  Object.defineProperty(planeElement, "clientHeight", { value: 1200 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  // The calls of the event writer are answered by the page-wire case of this test (docs/spec/cases/page-wire/README.md). The case is
  // selected before the modules that read the host are imported.
  const wire = selectPageWire(caseName);
  const { installEnvironment } = await import("../../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: PLAIN, title: "t" }] } } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: PLAIN, package: "@fixture/plain", version: "0.0.1", manifest: { id: PLAIN, name: PLAIN, description: "검사용 표면.",
    mark: "f", icon: "<path/>", surface: { composition: { kind: "view", page: "ui/index.html" } } } }] }), []);
  const { registry } = await import("../../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../../exposure.json", import.meta.url), "utf8")).exposes);
  const { logGate } = await import("../../log-gate.js");
  const { flushEvents } = await import("../../page-log.js");
  const plane = await import("../../plane.js");
  const { installCoreExposure } = await import("../../core-exposure.js");
  const { pageMemorySaver } = await import("./memory-saver.mjs");
  await installCoreExposure({ library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
    memorySaver: await pageMemorySaver() });
  plane.nameWindow("main");
  // The event is of the class call at the level debug, which this policy stores.
  logGate.set({ lifecycle: "error", input: "error", call: "debug", io: "error", frame: "error" });

  const content = (id) => {
    const tabs = [{ id: `tab-${id.slice(5)}aaaa`, plugin: PLAIN, title: id, origin: { directory: null }, role: null }];
    return { card: id, data: { tabs, activeId: tabs[0].id } };
  };
  plane.adopt({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 3, leader: "card-3",
    state: { root: { box: "card-3", data: { name: "그룹 1", leader: "card-1" }, inner: { cut: "x", kids: [
      { share: 0.5, node: content("card-1") }, { share: 0.5, node: content("card-2") },
    ] } } } }, "spc-aaaaaa");
  return { wire, registry, plane, flushEvents };
}
