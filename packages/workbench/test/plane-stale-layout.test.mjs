// After the plane builds a layout, it passes a drawing function to the onLayout receiver, and the receiver calls that function after the native preparation
// finishes. If the last tab of a closable card closes in between, the card disappears from the plane, but the drawing function that was passed still holds the earlier layout that
// contained that card. That drawing must finish without an exception (G1.4-26).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Console } from "node:console";
import { PassThrough } from "node:stream";
import { JSDOM } from "jsdom";

const pluginId = "fixture-stale-layout";

test("a held layout draw survives the close of a card it contains", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  // matchMedia, which JSDOM does not have. The view uses it only to subscribe to resolution changes, and this test does not change the resolution.
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
  // The size of the plane. JSDOM does not compute layout, so the test gives a size that has space to split.
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  // The border width that the app stylesheet gives a card and the width of a collapsed sidebar. JSDOM does not load app.css.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  // A page without a host bridge writes each reported failure to the error stream of its console, which the test reads.
  const reported = new PassThrough();
  // The lines written so far; a write to the stream is readable at once.
  const reports = () => (reported.read()?.toString() ?? "").split("\n").filter((line) => line !== "");
  const pageConsole = globalThis.console;
  globalThis.console = new Console({ stdout: reported, stderr: reported });
  // The layout of a new space: one card that cannot be closed. Its tab is a view of the installed plugin of the test.
  const { installEnvironment } = await import("../environment.js");
  installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } },
    sidebars: { sets: [], links: [] },
  }, {
    plugins: [{ id: pluginId, package: "@fixture/surface", version: "0.0.1", manifest: {
      id: pluginId, name: "Fixture", description: "검사용 표면.", mark: "f", icon: "<path/>",
      surface: { composition: { kind: "view", page: "ui/page.html" } },
    } }],
  });

  // The card elements connect only to declared core commands.
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  // The view of a tab is drawn as a placeholder in its slot, because this page has no native host (surface-modules.js).
  const placeholderOf = (surfaceId) => planeEl.querySelector(`.surface-placeholder[data-surface-id="${surfaceId}"]`);
  try {
    // The receiver keeps the drawing function and does not draw immediately. This is the same as a page that waits for the native preparation.
    let held = null;
    plane.onLayout((made, draw, seated, titlebar, holds) => { held = { made, draw, holds }; });
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    held.draw();
    // The drawing of a live card mounts the surface of its tab.
    const mainTab = plane.currentGrid().card("main").data.activeId;
    assert.ok(placeholderOf(mainTab), `the first draw did not mount the main tab ${mainTab}`);
    const stableCard = planeEl.querySelector('.card[data-card-id="main"]');
    const stableSlot = stableCard.querySelector(".slot");
    const stableAttributes = ["data-role", "data-focused", "data-native-surface", "data-native-surface-id",
      "data-native-layer", "data-native-plugin", "data-native-title", "data-native-dim"];
    const stableMutations = [];
    const observer = new dom.window.MutationObserver((records) => stableMutations.push(...records));
    observer.observe(stableCard, { attributes: true, subtree: true, attributeFilter: stableAttributes });
    plane.settle();
    held.draw();
    // The records not yet delivered are read synchronously, so the check does not yield before it judges the redraw.
    stableMutations.push(...observer.takeRecords());
    observer.disconnect();
    assert.deepEqual(stableMutations.map(({ attributeName }) => attributeName), [],
      "an unchanged redraw must not rewrite stable card or slot state attributes");
    const setCardTextSize = (textSize) => plane.currentGrid().setData("main", {
      ...plane.currentGrid().card("main").data, textSize,
    });
    setCardTextSize(1.5);
    plane.settle();
    held.draw();
    assert.equal(stableCard.dataset.textZoom, "", "a changed card text factor was not declared");
    assert.equal(stableCard.style.getPropertyValue("--text-zoom"), "1.5", "a changed card text factor was not applied");
    let textZoomSetCalls = 0;
    const stylePrototype = Object.getPrototypeOf(stableCard.style);
    const setProperty = stylePrototype.setProperty;
    stylePrototype.setProperty = function(name, ...args) {
      if (this === stableCard.style && name === "--text-zoom") textZoomSetCalls += 1;
      return setProperty.call(this, name, ...args);
    };
    const textZoomMutations = [];
    const textZoomObserver = new dom.window.MutationObserver((records) => textZoomMutations.push(...records));
    textZoomObserver.observe(stableCard, { attributes: true, attributeFilter: ["data-text-zoom", "style"] });
    const replacementTab = plane.addTabTo("main", pluginId, null);
    held.draw();
    textZoomMutations.push(...textZoomObserver.takeRecords());
    textZoomObserver.disconnect();
    assert.equal(textZoomSetCalls, 0, "an unchanged card text factor must not call CSSStyleDeclaration.setProperty");
    assert.deepEqual(textZoomMutations.map(({ attributeName }) => attributeName), [],
      "an unchanged card text factor must not rewrite its DOM state");
    stylePrototype.setProperty = setProperty;
    setCardTextSize(1);
    plane.settle();
    held.draw();
    assert.equal(stableCard.dataset.textZoom, undefined, "resetting card text scale did not remove its marker");
    assert.equal(stableCard.style.getPropertyValue("--text-zoom"), "", "resetting card text scale did not remove its property");
    let textZoomRemoveCalls = 0;
    const removeProperty = stylePrototype.removeProperty;
    stylePrototype.removeProperty = function(name, ...args) {
      if (this === stableCard.style && name === "--text-zoom") textZoomRemoveCalls += 1;
      return removeProperty.call(this, name, ...args);
    };
    const { card, tab } = plane.splitCard("main", "right", pluginId);
    held.draw();
    assert.equal(textZoomRemoveCalls, 0, "an unchanged default card text factor must not call CSSStyleDeclaration.removeProperty");
    stylePrototype.removeProperty = removeProperty;
    setCardTextSize(1.5);
    plane.settle();
    held.draw();
    assert.equal(stableCard.style.getPropertyValue("--text-zoom"), "1.5", "increasing card text scale did not restore its property");
    held.draw();
    assert.equal(stableSlot.dataset.nativeSurfaceId, replacementTab,
      "a changed active tab did not update the slot identity");
    assert.ok(plane.currentGrid().card(card), "the split made no card");
    held.draw();
    assert.equal(planeEl.querySelector(`.card[data-card-id="${card}"]`).dataset.focused, "true",
      "the split did not update the focused card state");
    plane.focusCard("main");
    held.draw();
    assert.equal(stableCard.dataset.focused, "true", "a changed focus did not update the card state");
    assert.equal(planeEl.querySelector(`.card[data-card-id="${card}"]`).dataset.focused, "false",
      "the prior focus remained on the split card");
    const stale = held;
    assert.ok(stale.made.has(card), "the held layout does not contain the split card");
    assert.equal(stale.holds(), true, "the seats of the newest layout must hold");
    // A tab that becomes active in a card moves the seat of that card: the held layout no longer names what the card shows.
    const behind = plane.addTabTo("main", pluginId, null);
    assert.equal(stale.holds(), false, `the held layout still holds after ${behind} became the active tab of main`);
    assert.equal(held.holds(), true, "the layout of the added tab must hold");
    const shown = held;
    await plane.closeTabById(behind);
    assert.equal(shown.holds(), false, "the layout held before the active tab closed must not hold");
    await plane.closeTabById(tab);
    assert.equal(plane.currentGrid().card(card), undefined, "closing the last tab left the card on the plane");
    // The next commit releases the surface of the closed tab, so its view is still in its slot, and a mount would replace it.
    const viewBefore = placeholderOf(tab);
    assert.doesNotThrow(() => stale.draw(), "drawing a layout held before the card closed must not throw");
    // The drawing of the earlier layout does not mount the closed tab again.
    assert.equal(placeholderOf(tab), viewBefore, `the closed tab ${tab} was mounted again by the stale draw`);
    assert.deepEqual(reports(), []);
  } finally {
    globalThis.console = pageConsole;
    dom.window.close();
  }
});
