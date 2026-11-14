// The page of the workbench for the verification tests: the document of index.html, the plane that draws one card of a plugin that no
// environment loads, the compositor and the host module of the page. Verification reads the plane and the compositor of that page, so
// the tests give them the geometry that the document provides (JSDOM has no layout) and the placement replies of the host.
//
// A test that places surfaces through the host selects its page-wire case before it opens the plane, because host.js reads the wire when
// it is imported (docs/spec/cases/page-wire/README.md). A test without a case opens the page without a host.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const here = (path) => new URL(path, import.meta.url);

/** A layout rectangle as the document returns it. */
export const rect = (x, y, w, h) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });

/** The slot attributes that the plane writes for the surface of a drawn tab (plane.js, updateCard). */
const SLOT_KEYS = ["nativeSurface", "nativeSurfaceId", "nativeLayer", "nativePlugin", "nativeTitle", "nativeDim"];

/**
 * Opens the page. The plane holds the card of the plugin "fixture-verify", which no environment loads, so the card draws a placeholder
 * and its slot holds no surface until a test marks it. The plugin "probe" is registered, so the compositor places its surfaces
 * through the host.
 */
export async function openVerifyPlane() {
  const dom = new JSDOM(readFileSync(here("../../index.html"), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
  // The view uses matchMedia only to subscribe to resolution changes, and these tests do not change the resolution.
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // A page always has a device pixel ratio; the plane aligns itself to its grid on every draw (device-grid.js).
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  // The size of the plane that the drawing reads. JSDOM does not compute layout, so the test gives the size.
  const planeEl = document.getElementById("plane");
  const size = { width: 800, height: 600 };
  Object.defineProperty(planeEl, "clientWidth", { get: () => size.width });
  Object.defineProperty(planeEl, "clientHeight", { get: () => size.height });
  // The border width and the width of a collapsed sidebar that app.css gives a card; JSDOM does not load app.css.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const { installEnvironment } = await import("../../environment.js");
  const refused = installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "fixture-verify", title: "main" }] }],
    } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [] });
  if (refused.length) throw new Error(`the fixture environment refused a plugin: ${JSON.stringify(refused)}`);
  // The card elements connect only to declared core commands.
  const { registry } = await import("../../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(here("../../exposure.json"), "utf8")).exposes);
  const { registerPlugin } = await import("../../registry.js");
  registerPlugin({ id: "probe", surface: () => ({ module: "probe.js", composition: { kind: "dom" } }) });
  const plane = await import("../../plane.js");
  const compositor = await import("../../compositor.js");
  const { surfaces } = await import("../../host.js");
  const { verify } = await import("../../verify.js");
  const { halfGap } = await import("../../settings.js");
  // The compositor reports each commit to the host placement, as the page does (index.html).
  compositor.onCommit((record) => surfaces.place(record));
  plane.adopt(plane.fresh(), "spc-aaaaaa");
  plane.setGap(halfGap());
  plane.settle();

  const card = planeEl.querySelector(".card[data-card-id]");
  const slot = card.querySelector(".slot");
  const measured = new Set();
  const added = new Set();
  return {
    plane, compositor, surfaces, verify, planeEl, card, slot, size,
    /** Draws the plane again at the size that the test set. */
    redraw() {
      plane.setGap(halfGap());
      plane.settle();
    },
    /** Gives the element the rectangle that the layout of a browser would measure for it. */
    measure(element, box) {
      element.getBoundingClientRect = () => box;
      measured.add(element);
    },
    /** Adds the markup of one element to the plane, as a drawing that came after the commit does. */
    append(markup) {
      const holder = document.createElement("div");
      holder.innerHTML = markup;
      const element = holder.firstElementChild;
      planeEl.append(element);
      added.add(element);
      return element;
    },
    /** Marks the slot of the card as the slot of a surface, as the drawing of the plane does for a tab of a loaded plugin. */
    mark({ id = "probe", plugin = "probe", dim = false, composition = { kind: "dom" } } = {}) {
      slot.dataset.nativeSurface = "view";
      slot.dataset.nativeSurfaceId = id;
      slot.dataset.nativeLayer = "0";
      slot.dataset.nativePlugin = plugin;
      slot.dataset.nativeTitle = id;
      slot.dataset.nativeDim = String(dim);
      compositor.setSlotSurface(slot, { surfaceId: id, pluginId: plugin, composition });
    },
    /** Returns the page to the state in which the next test starts: no measurement, no surface, no added element and no request sent. */
    reset() {
      for (const element of measured) delete element.getBoundingClientRect;
      measured.clear();
      for (const element of added) element.remove();
      added.clear();
      compositor.clearSlotSurface(slot);
      for (const key of SLOT_KEYS) delete slot.dataset[key];
      for (const property of ["width", "height", "--pt"]) card.style.removeProperty(property);
      size.width = 800;
      size.height = 600;
      globalThis.devicePixelRatio = dom.window.devicePixelRatio;
      // The window of the next test has sent no request.
      surfaces.forget();
    },
    close() {
      dom.window.close();
    },
  };
}
