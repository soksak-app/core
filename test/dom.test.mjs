import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { Soksak, SoksakView } from "../dist/index.js";

/**
 * Tests for SoksakView, run against jsdom.
 *
 * The rest of the suite is headless, so the view had no test coverage.
 *
 * jsdom performs no layout and every element measures 0x0. The tests set the
 * host size explicitly and check element lifecycle, written attributes, and
 * pointer handling.
 */
const W = 1200;
const H = 600;

function mount(options = {}) {
  const dom = new JSDOM("<!doctype html><div id=host></div>", { pretendToBeVisual: true });
  const { window } = dom;
  for (const name of ["PointerEvent", "Event", "Node", "HTMLElement"]) {
    globalThis[name] = window[name];
  }
  globalThis.document = window.document;
  // jsdom has no ResizeObserver. The view must work without it.
  delete globalThis.ResizeObserver;

  const host = window.document.getElementById("host");
  Object.defineProperty(host, "clientWidth", { value: W, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: H, configurable: true });

  const grid = new Soksak(undefined, { width: W, height: H, gap: 24 });
  grid.split("card", "x");
  const made = [];
  const gone = [];
  const view = new SoksakView(host, grid, {
    createCard: (card) => {
      made.push(card.id);
      const el = window.document.createElement("div");
      el.dataset.cardId = card.id;
      return el;
    },
    destroyCard: (_el, card) => gone.push(card.id),
    ...options,
  });
  view.render();                      // the constructor does not render
  return { dom, window, host, grid, view, made, gone };
}

const pointer = (window, el, type, id, x, y) =>
  el.dispatchEvent(
    new window.PointerEvent(type, {
      pointerId: id,
      clientX: x,
      clientY: y,
      bubbles: true,
      isPrimary: id === 1,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
    }),
  );

test("the view creates and removes one element per card", () => {
  const { host, grid, view, made, gone } = mount();
  assert.deepEqual(made.sort(), ["card", "card-1"], "one element each");
  assert.equal(host.querySelectorAll("[data-card-id]").length, 2);

  const born = grid.split("card", "x");
  view.render();
  assert.ok(made.includes(born), "a new card gets an element");
  assert.equal(host.querySelectorAll("[data-card-id]").length, 3);

  grid.close(born);
  view.render();
  assert.deepEqual(gone, [born], "and a closed one gives it back");
  assert.equal(host.querySelectorAll("[data-card-id]").length, 2);

  view.destroy();
  assert.equal(host.children.length, 0, "destroy leaves the host as it found it");
});

test("a card element is reused across splits and closes", () => {
  const { grid, view, made } = mount();
  const kept = view.element("card");
  kept.dataset.live = "pty-1";

  for (let i = 0; i < 5; i++) {
    const born = grid.split("card-1", i % 2 ? "y" : "x");
    view.render();
    if (born) grid.close(born);
    view.render();
  }
  assert.equal(view.element("card"), kept, "the same element, not a new one");
  assert.equal(kept.dataset.live, "pty-1", "with what the host put on it");
  assert.equal(made.filter((id) => id === "card").length, 1, "created once");
});

test("the view places every element on the grid rect", () => {
  const { host, grid, view } = mount();
  grid.split("card", "x");
  grid.split("card", "y");
  view.render();

  // Against the numbers the grid reports, not against the style being present:
  // a view that drew every card 0x0 in the corner passed the old check.
  for (const [id, rect] of grid.rects()) {
    const el = view.element(id);
    assert.ok(el, `${id} has an element`);
    assert.equal(el.style.left, `${rect.x}px`, `${id} left`);
    assert.equal(el.style.top, `${rect.y}px`, `${id} top`);
    assert.equal(el.style.width, `${rect.w}px`, `${id} width`);
    assert.equal(el.style.height, `${rect.h}px`, `${id} height`);
    assert.equal(el.dataset.cardId, id);
  }
  for (const divider of grid.dividers()) {
    const el = host.querySelector(`.sp-divider[data-axis="${divider.axis}"][data-line="${divider.line}"]`);
    assert.ok(el, `${divider.key} has an element`);
    assert.equal(el.style.left, `${divider.x}px`, `${divider.key} left`);
    assert.equal(el.style.width, `${divider.w}px`, `${divider.key} width`);
  }
  assert.equal(host.querySelectorAll(".sp-divider").length, grid.dividers().length);

  const style = view.element("card").getAttribute("style") ?? "";
  for (const banned of ["background", "border", "color", "font"]) {
    assert.ok(!style.includes(banned), `the view set ${banned}`);
  }
});

test("a host that has not been laid out keeps the size the grid was given", () => {
  const dom = new JSDOM("<!doctype html><div id=host></div>", { pretendToBeVisual: true });
  globalThis.document = dom.window.document;
  delete globalThis.ResizeObserver;
  const host = dom.window.document.getElementById("host");   // clientWidth is 0 in jsdom

  const grid = new Soksak(undefined, { width: W, height: H });
  const view = new SoksakView(host, grid, { createCard: () => dom.window.document.createElement("div") });
  assert.equal(grid.width, W, "not measured as nothing");
  assert.equal(grid.height, H);
  assert.ok(grid.rect("card").w > 0, "so the card has area");
  view.destroy();
});

test("two pointers drag two dividers independently", () => {
  const { window, host, grid, view } = mount();
  grid.split("card", "y");                       // now there is a divider on each axis
  view.render();

  const vertical = host.querySelector('.sp-divider[data-axis="x"]');
  const horizontal = host.querySelector('.sp-divider[data-axis="y"]');
  assert.ok(vertical && horizontal, "one divider on each axis");

  const xs = [...grid.lines("x")];
  const ys = [...grid.lines("y")];

  const wasX = grid.boundaryPos("x", 1);
  pointer(window, vertical, "pointerdown", 1, 600, 300);
  pointer(window, horizontal, "pointerdown", 2, 300, 300);
  pointer(window, vertical, "pointermove", 1, 400, 300);   // only the first finger moves

  // Where it went, not merely that something changed: a drag that moved the
  // boundary the wrong way, or by the wrong amount, passed the old check.
  assert.equal(grid.boundaryPos("x", 1), wasX - 200, "it followed the finger");
  assert.notDeepEqual(grid.lines("x"), xs, "the divider under that finger moved");
  assert.deepEqual(grid.lines("y"), ys, "the other one did not");

  pointer(window, vertical, "pointerup", 1, 400, 300);
  pointer(window, horizontal, "pointerup", 2, 300, 300);
  assert.equal(vertical.dataset.dragging, undefined, "and neither is left held down");
  assert.equal(horizontal.dataset.dragging, undefined);
});

test("pointercancel and pointerup both end a drag", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  for (const ending of ["pointercancel", "pointerup"]) {
    const before = [...grid.lines("x")];
    pointer(window, el, "pointerdown", 1, 600, 300);
    pointer(window, el, "pointermove", 1, 500, 300);
    assert.notDeepEqual(grid.lines("x"), before, `${ending}: it moved`);
    pointer(window, el, ending, 1, 500, 300);
    assert.equal(el.dataset.dragging, undefined, `${ending}: and let go`);

    const after = [...grid.lines("x")];
    pointer(window, el, "pointermove", 1, 900, 300);
    assert.deepEqual(grid.lines("x"), after, `${ending}: a move after it does nothing`);
    view.render();
  }
});

test("a destroyed view handles no further input", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  view.destroy();

  const before = [...grid.lines("x")];
  pointer(window, el, "pointerdown", 1, 600, 300);
  pointer(window, el, "pointermove", 1, 300, 300);
  assert.deepEqual(grid.lines("x"), before, "a detached divider drives nothing");

  const born = grid.split("card", "x");
  view.render();
  assert.equal(host.children.length, 0, "and render after destroy adds nothing");
  void born;
});

test("onChange reports the reason for each change", () => {
  const reasons = [];
  const { window, host, view } = mount({ onChange: (r) => reasons.push(r) });
  reasons.length = 0;

  view.render();
  assert.deepEqual(reasons, ["render"]);

  const el = host.querySelector('.sp-divider[data-axis="x"]');
  reasons.length = 0;
  pointer(window, el, "pointerdown", 1, 600, 300);
  pointer(window, el, "pointermove", 1, 500, 300);
  pointer(window, el, "pointerup", 1, 500, 300);
  assert.ok(reasons.includes("drag"), `a drag reports drag: ${reasons}`);
  assert.ok(!reasons.includes("resize"), "and does not report resize");
});

test("a destroyed view handles no key either", () => {
  const { host, grid, view } = mount();
  view.render();
  const divider = host.querySelector(".sp-divider");
  assert.ok(divider, "a divider to press");

  view.destroy();
  const before = JSON.stringify(grid.toJSON());
  for (let i = 0; i < 5; i++) {
    divider.dispatchEvent(new host.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  }
  divider.dispatchEvent(new host.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(JSON.stringify(grid.toJSON()), before, "the grid is untouched");
});

test("a render writes only what changed", () => {
  const { host, grid, view } = mount();
  view.render();

  const el = host.querySelector("[data-card-id]");
  const style = el.style;
  let writes = 0;
  const watched = new Proxy(style, {
    set(target, key, value) {
      writes++;
      return Reflect.set(target, key, value);
    },
  });
  Object.defineProperty(el, "style", { value: watched, configurable: true });

  view.render();
  assert.equal(writes, 0, "a render that changes nothing writes nothing");

  // data attributes are written when the element is built, and the key an
  // element is kept under already carries them.
  const before = { ...el.dataset };
  view.render();
  assert.deepEqual({ ...el.dataset }, before);

  grid.moveBoundary("x", 1, grid.boundaryPos("x", 1) + 20);
  view.render("drag");
  assert.ok(writes > 0, "and a render that moves a card writes");
});
