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

test("the view accepts the mouse drag contract for dividers", () => {
  const changes = [];
  const { window, host, grid, view } = mount({ onChange: (reason) => changes.push(reason) });
  const divider = host.querySelector('[role="separator"]');
  assert.ok(divider);
  const boundaryBefore = grid.boundaryPos("x", 1);

  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: boundaryBefore,
    clientY: 100,
    bubbles: true,
    button: 0,
    buttons: 1,
  }));
  window.document.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: boundaryBefore + 80,
    clientY: 100,
    bubbles: true,
    buttons: 1,
  }));
  window.document.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: boundaryBefore + 80,
    clientY: 100,
    bubbles: true,
    button: 0,
    buttons: 0,
  }));

  assert.equal(grid.boundaryPos("x", 1), boundaryBefore + 80);
  assert.ok(changes.includes("drag"));
  view.destroy();
});

test("a divider held by the mouse carries data-dragging", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  const at = grid.boundaryPos("x", 1);

  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: at, clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  assert.equal(divider.dataset.dragging, "true", "a held divider carries data-dragging");

  window.document.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: at + 40, clientY: 100, bubbles: true, buttons: 1,
  }));
  assert.equal(divider.dataset.dragging, "true", "it still carries it while it moves");

  window.document.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: at + 40, clientY: 100, bubbles: true, button: 0, buttons: 0,
  }));
  assert.equal(divider.dataset.dragging, undefined, "letting go takes it off");
  view.destroy();
});

test("a divider the mouse let go of elsewhere stops saying it is held", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  const at = grid.boundaryPos("x", 1);

  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: at, clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  // A button released outside the window sends no mouseup; the next move reports it.
  window.document.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: at + 40, clientY: 100, bubbles: true, buttons: 0,
  }));
  assert.equal(divider.dataset.dragging, undefined);
  view.destroy();
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

test("the keyboard moves and centres a boundary", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const key = (name) =>
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

  const from = grid.boundaryPos("x", 1);
  key("ArrowRight");
  assert.equal(grid.boundaryPos("x", 1), from + 8, "one step right");
  key("ArrowLeft");
  key("ArrowLeft");
  assert.equal(grid.boundaryPos("x", 1), from - 8, "and back past where it started");

  key("Home");
  assert.equal(grid.boundaryPos("x", 1), from - 8, "a key it does not use changes nothing");

  for (const name of ["Enter", " "]) {
    grid.moveBoundary("x", 1, from + 200);
    const off = grid.boundaryPos("x", 1);
    const centred = grid.centerBoundary("x", 1);   // where centring puts it
    grid.moveBoundary("x", 1, off);                // and back off centre
    key(name);
    assert.equal(grid.boundaryPos("x", 1), centred, `${name} centres it`);
    assert.notEqual(centred, off, "and that is somewhere else");
  }
  view.destroy();
});

test("a double tap centres the boundary", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  grid.moveBoundary("x", 1, grid.boundaryPos("x", 1) + 200);
  const off = grid.boundaryPos("x", 1);
  const centred = grid.centerBoundary("x", 1);   // where centring puts it
  grid.moveBoundary("x", 1, off);                // and back off centre

  // Two presses inside the double-tap window, with no movement between them.
  pointer(window, el, "pointerdown", 1, off, 300);
  pointer(window, el, "pointerup", 1, off, 300);
  pointer(window, el, "pointerdown", 1, off, 300);
  pointer(window, el, "pointerup", 1, off, 300);

  assert.notEqual(grid.boundaryPos("x", 1), off, "it moved");
  assert.equal(grid.boundaryPos("x", 1), centred, "to the centre");
  view.destroy();
});

test("a move with no button down ends the drag", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const from = grid.boundaryPos("x", 1);

  pointer(window, el, "pointerdown", 1, from, 300);
  pointer(window, el, "pointermove", 1, from - 100, 300);
  const held = grid.boundaryPos("x", 1);
  assert.equal(held, from - 100, "a move with the button down drags");

  // The pointerup never arrives — the element lost the capture. The next move
  // has no button down, and must end the drag rather than keep dragging.
  el.dispatchEvent(
    new window.PointerEvent("pointermove", { pointerId: 1, clientX: from - 400, clientY: 300, buttons: 0, bubbles: true }),
  );
  assert.equal(grid.boundaryPos("x", 1), held, "that move did not drag");
  assert.equal(el.dataset.dragging, undefined, "and the drag is over");

  el.dispatchEvent(
    new window.PointerEvent("pointermove", { pointerId: 1, clientX: from - 500, clientY: 300, buttons: 1, bubbles: true }),
  );
  assert.equal(grid.boundaryPos("x", 1), held, "a later move does not resume it");
  view.destroy();
});

test("a divider swept away mid-drag ends its drag", () => {
  const { window, host, grid, view } = mount();
  const born = grid.split("card", "y");
  view.render();
  const el = host.querySelector('.sp-divider[data-axis="y"]');
  const from = grid.boundaryPos("y", 1);

  pointer(window, el, "pointerdown", 1, 300, from);
  pointer(window, el, "pointermove", 1, 300, from + 40);
  assert.equal(el.dataset.dragging, "true");

  // The host closes the card that boundary belonged to, and renders.
  assert.equal(grid.close(born), true);
  view.render();
  assert.equal(el.isConnected, false, "the divider is gone");

  const settled = grid.boundaryPos("x", 1);
  const other = host.querySelector('.sp-divider[data-axis="x"]');
  other.dispatchEvent(
    new window.PointerEvent("pointermove", { pointerId: 1, clientX: 100, clientY: 300, buttons: 1, bubbles: true }),
  );
  assert.equal(grid.boundaryPos("x", 1), settled, "and no other divider inherits the drag");
  view.destroy();
});

test("the view follows the host's size, and ignores a host with none", () => {
  // jsdom has no ResizeObserver, so the block that reads the host's size had
  // never run — including the guard its own comment warns about.
  const dom = new JSDOM("<!doctype html><div id=host></div>", { pretendToBeVisual: true });
  globalThis.document = dom.window.document;
  const host = dom.window.document.getElementById("host");
  let fire = () => {};
  globalThis.ResizeObserver = class {
    constructor(cb) {
      fire = cb;
    }
    observe() {}
    disconnect() {
      fire = () => {};
    }
  };
  const size = (w, h) => {
    Object.defineProperty(host, "clientWidth", { value: w, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: h, configurable: true });
  };

  size(1000, 800);
  const grid = new Soksak(undefined, { width: 1000, height: 800, gap: 24 });
  grid.split("card", "x");
  grid.setSize("card", "x", 300);
  const reasons = [];
  const view = new SoksakView(host, grid, {
    createCard: () => dom.window.document.createElement("div"),
    onChange: (reason) => reasons.push(reason),
  });

  size(600, 500);
  fire();
  assert.deepEqual([grid.width, grid.height], [600, 500], "the grid took the new size");
  assert.ok(reasons.includes("resize"), "and the host was told");

  // A hidden host reports nothing. Writing that in scaled every px size to zero
  // and showing the host again did not bring them back.
  size(0, 0);
  fire();
  assert.deepEqual([grid.width, grid.height], [600, 500], "a host with no layout is ignored");
  assert.equal(grid.card("card").width, 300, "so the px size survives");

  size(1000, 800);
  fire();
  assert.deepEqual([grid.width, grid.height], [1000, 800]);
  assert.equal(grid.rect("card").w, 300, "and it is drawn at the size it declares");

  view.destroy();
  size(400, 400);
  fire();
  assert.deepEqual([grid.width, grid.height], [1000, 800], "a destroyed view stops observing");
  delete globalThis.ResizeObserver;
});

test("the view calls back and honours its options", () => {
  const updates = [];
  const dividerUpdates = [];
  const { host, grid, view, gone } = mount({
    classPrefix: "px",
    updateCard: (el, card, rect) => updates.push([card.id, rect.w, el.dataset.cardId]),
    updateDivider: (el, divider) => dividerUpdates.push([el, divider.key, divider.axis, divider.line]),
  });

  assert.ok(updates.length > 0, "updateCard is called for every card");
  for (const [id, w, marked] of updates) {
    assert.equal(w, grid.rect(id).w, `${id} was handed the rect it was placed at`);
    assert.equal(marked, id, "and its own element");
  }

  assert.equal(host.querySelectorAll(".px-divider").length > 0, true, "classPrefix is used");
  assert.equal(host.querySelectorAll(".sp-divider").length, 0, "and the default is not");
  assert.equal(host.querySelectorAll(".px-rule").length, grid.rules().length);
  assert.deepEqual(
    dividerUpdates.map(([, key, axis, line]) => [key, axis, line]),
    grid.dividers().map((divider) => [divider.key, divider.axis, divider.line]),
    "updateDivider receives each placed divider",
  );

  // Every rule carries the axis and whether it runs the whole plane.
  for (const rule of grid.rules()) {
    const el = host.querySelector(
      `.px-rule[data-axis="${rule.axis}"][data-virtual="${rule.virtual}"]`,
    );
    assert.ok(el, `${rule.key} has an element marked with what it is`);
  }

  const ids = grid.cards.map((c) => c.id);
  view.destroy();
  assert.deepEqual(gone.sort(), [...ids].sort(), "destroyCard for each card");
  assert.equal(host.children.length, 0, "and every element it made is gone");
  // Removed from the document is not the same as let go of: a view that keeps
  // its map still returns them and keeps them alive.
  for (const id of ids) assert.equal(view.element(id), undefined, `${id} is released`);
});

test("rules: false draws no rules and still draws the grab areas", () => {
  const { host, grid, view } = mount({ rules: false });
  assert.equal(host.querySelectorAll(".sp-rule").length, 0);
  assert.equal(host.querySelectorAll(".sp-divider").length, grid.dividers().length);
  view.destroy();
});

test("releasing the pointer folds a pair the drag brought together", () => {
  const reasons = [];
  const { window, host, grid, view } = mount({ onChange: (reason) => reasons.push(reason) });
  // A line no card reads is a snap target with no minimum to respect, which is
  // the case a drag can actually bring together.
  grid.split("card", "y");
  const spare = grid.split("card", "x");
  grid.close(spare);
  const virtual = [1, 2].find((k) => grid.isVirtual("x", k));
  assert.ok(virtual, "a line no card reads");
  view.render();

  const lines = grid.lines("x").length;
  const beside = grid
    .dividers()
    .find((d) => d.axis === "x" && Math.abs(d.line - virtual) === 1);
  assert.ok(beside, "a divider next to it");
  const el = host.querySelector(`.sp-divider[data-axis="x"][data-line="${beside.line}"]`);
  assert.ok(el, "with an element");

  const from = grid.boundaryPos("x", beside.line);
  const onto = grid.boundaryPos("x", virtual);
  pointer(window, el, "pointerdown", 1, from, 300);
  pointer(window, el, "pointermove", 1, onto - 2, 300);   // inside snapDistance
  reasons.length = 0;
  pointer(window, el, "pointerup", 1, onto - 2, 300);

  assert.equal(grid.lines("x").length, lines - 1, "the two lines were folded into one");
  assert.ok(reasons.includes("merge"), "and the host was told it was a merge");
  view.destroy();
});

test("losing the capture ends the drag", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const from = grid.boundaryPos("x", 1);

  pointer(window, el, "pointerdown", 1, from, 300);
  pointer(window, el, "pointermove", 1, from - 60, 300);
  const held = grid.boundaryPos("x", 1);
  assert.equal(held, from - 60);

  el.dispatchEvent(new window.PointerEvent("lostpointercapture", { pointerId: 1, bubbles: true }));
  assert.equal(el.dataset.dragging, undefined, "the drag is over");

  el.dispatchEvent(
    new window.PointerEvent("pointermove", { pointerId: 1, clientX: from - 300, clientY: 300, buttons: 1, bubbles: true }),
  );
  assert.equal(grid.boundaryPos("x", 1), held, "and a later move does not resume it");
  view.destroy();
});

test("destroy ends a drag in flight and releases what it held", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const from = grid.boundaryPos("x", 1);
  let released = 0;
  el.releasePointerCapture = () => {
    released++;
  };

  pointer(window, el, "pointerdown", 1, from, 300);
  pointer(window, el, "pointermove", 1, from - 40, 300);
  assert.equal(el.dataset.dragging, "true");

  view.destroy();
  assert.equal(released, 1, "the capture was released");
  assert.equal(el.dataset.dragging, undefined, "and the divider is not left held");
});

test("a swept divider does not stay held", () => {
  const { window, host, grid, view } = mount();
  const born = grid.split("card", "y");
  view.render();
  const el = host.querySelector('.sp-divider[data-axis="y"]');
  let released = 0;
  el.releasePointerCapture = () => {
    released++;
  };

  pointer(window, el, "pointerdown", 1, 300, grid.boundaryPos("y", 1));
  pointer(window, el, "pointermove", 1, 300, grid.boundaryPos("y", 1) + 40);
  assert.equal(el.dataset.dragging, "true");

  grid.close(born);
  view.render();
  assert.equal(el.isConnected, false, "the divider is gone");
  assert.equal(el.dataset.dragging, undefined, "and it is not still marked as held");
  assert.equal(released, 1, "its capture was released");
  view.destroy();
});

test("element() returns the element for a card the grid still has", () => {
  const { grid, view } = mount();
  const born = grid.split("card", "y");
  view.render();
  assert.ok(view.element(born), "a card that is there has an element");

  grid.close(born);
  view.render();
  assert.equal(view.element(born), undefined, "and one that is gone has none");
  view.destroy();
});

test("sweeping one divider ends its drag and no one else's", () => {
  const { window, host, grid, view } = mount();
  grid.split("card", "y");
  view.render();

  const vertical = host.querySelector('.sp-divider[data-axis="x"]');
  const horizontal = host.querySelector('.sp-divider[data-axis="y"]');
  pointer(window, vertical, "pointerdown", 1, grid.boundaryPos("x", 1), 300);
  pointer(window, vertical, "pointermove", 1, grid.boundaryPos("x", 1) - 30, 300);
  pointer(window, horizontal, "pointerdown", 2, 300, grid.boundaryPos("y", 1));
  pointer(window, horizontal, "pointermove", 2, 300, grid.boundaryPos("y", 1) + 30);
  assert.equal(vertical.dataset.dragging, "true");
  assert.equal(horizontal.dataset.dragging, "true");

  // Close the card whose boundary the horizontal divider draws. Sweeping it
  // must end its own drag and leave the other pointer holding its own.
  grid.close(grid.cards.find((c) => c.r0 === 1)?.id ?? "card-2");
  view.render();
  assert.equal(horizontal.isConnected, false, "the horizontal divider is gone");
  assert.equal(horizontal.dataset.dragging, undefined, "and its drag ended");
  assert.equal(vertical.dataset.dragging, "true", "the other one is still held");

  const held = grid.boundaryPos("x", 1);
  pointer(window, vertical, "pointermove", 1, grid.boundaryPos("x", 1) - 40, 300);
  assert.notEqual(grid.boundaryPos("x", 1), held, "and still follows its pointer");
  view.destroy();
});

test("a rule reaches the frame the host holds the plane inside", () => {
  const { host, grid, view } = mount({ bleed: 12 });
  grid.split("card", "y");
  view.render();

  for (const rule of grid.rules()) {
    const el = host.querySelector(
      `.sp-rule[data-axis="${rule.axis}"][data-virtual="${rule.virtual}"]`,
    );
    if (!el) continue;
  }
  const reaching = grid.rules().filter((r) => r.axis === "x" && r.y <= 0.5);
  assert.ok(reaching.length, "a rule that starts at the plane's edge");

  // Only the ends that reach the plane bleed. A rule that stops against a card
  // is left where it stops, because there the card is the wall.
  const all = [...host.querySelectorAll('.sp-rule[data-axis="x"]')];
  assert.ok(all.length, "the view drew them");
  for (const el of all) {
    assert.equal(el.style.top, "-12px", "it starts a bleed above the plane");
  }
  const full = all.filter((el) => parseFloat(el.style.height) === H + 24);
  assert.ok(full.length, "one that spans the plane runs a bleed past each end");

  const short = [...host.querySelectorAll('.sp-rule[data-axis="y"]')].map((el) => el.style.left);
  for (const left of short) assert.equal(left, "-12px", "and on the other axis too");
  view.destroy();
});

test("no bleed is the default, and nothing runs past the plane", () => {
  const { host, grid, view } = mount();
  grid.split("card", "y");
  view.render();
  for (const el of host.querySelectorAll(".sp-rule")) {
    assert.ok(parseFloat(el.style.left) >= 0, `left ${el.style.left}`);
    assert.ok(parseFloat(el.style.top) >= 0, `top ${el.style.top}`);
    assert.ok(parseFloat(el.style.left) + parseFloat(el.style.width) <= W + 1e-9);
    assert.ok(parseFloat(el.style.top) + parseFloat(el.style.height) <= H + 1e-9);
  }
  view.destroy();
});

test("bleed is readable and writable, and refuses a value that is not one", () => {
  const { host, grid, view } = mount();
  assert.equal(view.bleed, 0, "nothing by default");

  view.bleed = 20;
  assert.equal(view.bleed, 20, "it reads back what it was set to");
  view.render();
  for (const el of host.querySelectorAll('.sp-rule[data-axis="x"]')) {
    assert.equal(el.style.top, "-20px", "and the rules follow it");
  }

  view.bleed = 6;
  view.render();
  for (const el of host.querySelectorAll('.sp-rule[data-axis="x"]')) {
    assert.equal(el.style.top, "-6px", "including downward");
  }

  for (const bad of [-1, NaN, Infinity]) {
    view.bleed = bad;
    assert.equal(view.bleed, 6, `${bad} is ignored`);
  }
  view.bleed = 0;
  assert.equal(view.bleed, 0, "and zero is a distance");
  view.render();
  assert.equal(host.querySelector('.sp-rule[data-axis="x"]').style.top, "0px");
  assert.ok(grid.cards.length, "the plane is untouched by any of it");
  view.destroy();
});
