import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { Soksak, SoksakView, installTheme, themeCSS } from "../dist/index.js";

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

test("a mouse drag renders once more when it ends", () => {
  const changes = [];
  const { window, host, grid, view } = mount({ onChange: (reason) => changes.push(reason) });
  const divider = host.querySelector('[role="separator"]');
  const at = grid.boundaryPos("x", 1);

  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: at, clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  window.document.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: at + 40, clientY: 100, bubbles: true, buttons: 1,
  }));
  const during = changes.length;
  window.document.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: at + 40, clientY: 100, bubbles: true, button: 0, buttons: 0,
  }));

  assert.ok(changes.length > during, "letting go renders once more");
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

  // What the README says every element carries. Without these the values above
  // place nothing: a card that is not positioned ignores left and top, a rule
  // that takes presses swallows them, and a grab area that no key reaches and
  // that a touch scrolls cannot be dragged.
  assert.equal(view.element("card").style.position, "absolute", "a card is placed");
  const rule = host.querySelector(".sp-rule");
  assert.ok(rule, "the view drew a rule");
  assert.equal(rule.style.position, "absolute", "a rule is placed");
  assert.equal(rule.style.pointerEvents, "none", "and takes no press");
  const grab = host.querySelector(".sp-divider");
  assert.equal(grab.style.position, "absolute", "a grab area is placed");
  assert.equal(grab.style.touchAction, "none", "a touch on it does not scroll");
  assert.equal(grab.getAttribute("tabindex"), "0", "and a key reaches it");
});

test("a line no card reads is not drawn", () => {
  const { host, grid, view } = mount();
  grid.close("card");
  view.render();

  assert.equal(grid.lines("x").length, 3, "the line stays in the array");
  assert.equal(grid.isVirtual("x", 1), true, "and no card reads it");
  assert.equal(grid.rules().length, 0, "so there is no rule for it");
  assert.equal(host.querySelectorAll(".sp-rule").length, 0, "and nothing is drawn");

  // The line is what the card that paid comes back to.
  grid.split("card-1", "x");
  view.render();
  assert.equal(grid.boundaryPos("x", 1), 600, "the boundary comes back where it was");
  assert.ok(host.querySelectorAll(".sp-rule").length > 0, "and its rule is drawn again");
});

test("a press that follows a drag whose release was lost is not the second of a pair", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  const doc = window.document;
  const at = grid.boundaryPos("x", 1);

  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: at, clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  doc.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: at + 300, clientY: 100, bubbles: true, buttons: 1,
  }));
  const moved = grid.boundaryPos("x", 1);

  // The release produced no event at all, and the pointer did not move again.
  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: at + 300, clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  assert.equal(grid.boundaryPos("x", 1), moved, "the next press starts a drag, it does not centre");
  doc.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: at + 300, clientY: 100, bubbles: true, button: 0, buttons: 0,
  }));
  view.destroy();
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
  // boundary the wrong way, or by the wrong amount, passed the old check. The
  // position is converted through the normalised array and back, so it carries
  // the rounding of that conversion.
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - (wasX - 200)) < 1e-9,
    `it followed the finger to ${grid.boundaryPos("x", 1)}, not ${wasX - 200}`,
  );
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
  // 두 번째 카드만 가로로 나눈다. 그 선의 규칙은 왼쪽 끝이 판 안에서 멈추고 오른쪽
  // 끝만 판의 가장자리에 닿으므로, 한 규칙 안에서 두 경우를 모두 볼 수 있다.
  grid.split([...grid.cards][1].id, "y");
  view.render();

  const across = [...host.querySelectorAll('.sp-rule[data-axis="y"]')];
  const spanning = across.filter((el) => parseFloat(el.style.left) < 0);
  const stopping = across.filter((el) => parseFloat(el.style.left) > 0);
  assert.equal(spanning.length, 1, "one runs the whole width");
  assert.equal(stopping.length, 1, "and one stops against a card");
  assert.equal(spanning[0].style.left, "-12px", "the one that reaches bleeds past the edge");
  assert.equal(parseFloat(spanning[0].style.width), W + 24, "at both ends");
  // 카드에 막힌 끝은 그 자리에 둔다. 거기서는 카드가 벽이다.
  assert.equal(stopping[0].style.left, `${W / 2}px`, "the end a card stops is left where it stops");
  assert.equal(parseFloat(stopping[0].style.width), W / 2 + 12, "and the other end still bleeds");

  const down = [...host.querySelectorAll('.sp-rule[data-axis="x"]')];
  assert.ok(down.length, "the view drew the rules on the other axis too");
  for (const el of down) {
    assert.equal(el.style.top, "-12px", "each starts a bleed above the plane");
    assert.equal(parseFloat(el.style.height), H + 24, "and runs one past its foot");
  }
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
  view.destroy();
});

test("a divider swept while the mouse holds it stops driving the boundary", () => {
  const { window, host, grid, view } = mount();
  const born = grid.split("card", "y");         // a second axis, so one can go
  view.render();
  assert.ok(born, "the split made a card");
  const divider = host.querySelector('[role="separator"][data-axis="y"]');
  const at = grid.boundaryPos("y", 1);

  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: 100, clientY: at, bubbles: true, button: 0, buttons: 1,
  }));
  // The card goes, so the boundary and its divider go with it.
  assert.ok(grid.close(born), "the card closed");
  view.render();
  assert.equal(divider.dataset.dragging, undefined, "a swept divider is not held");

  const lines = grid.lines("y").join(",");
  window.document.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: 100, clientY: at + 120, bubbles: true, buttons: 1,
  }));
  assert.equal(grid.lines("y").join(","), lines, "moving the mouse moves nothing");
  view.destroy();
});

test("the host commits a centre and the end of a drag, not only the moves inside one", () => {
  const committed = [];
  const { window, host, grid, view } = mount({
    commit: (rects, draw) => { committed.push(rects.size); draw(); },
  });
  const divider = host.querySelector('[role="separator"]');

  const before = committed.length;
  divider.dispatchEvent(new window.PointerEvent("pointerdown", {
    pointerId: 1, clientX: grid.boundaryPos("x", 1), clientY: 100,
    bubbles: true, isPrimary: true, button: 0, buttons: 1,
  }));
  divider.dispatchEvent(new window.PointerEvent("pointerdown", {
    pointerId: 1, clientX: grid.boundaryPos("x", 1), clientY: 100,
    bubbles: true, isPrimary: true, button: 0, buttons: 1,
  }));
  assert.ok(committed.length > before, "a centre is committed");

  const beforeEnd = committed.length;
  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: grid.boundaryPos("x", 1), clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  window.document.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: grid.boundaryPos("x", 1), clientY: 100, bubbles: true, button: 0, buttons: 0,
  }));
  assert.ok(committed.length > beforeEnd, "the end of a drag is committed");
  view.destroy();
});

test("a second mouse press releases the divider the first one held", () => {
  const { window, host, grid, view } = mount();
  grid.split("card", "y");
  view.render();
  const [across, down] = ["x", "y"].map((axis) =>
    host.querySelector(`[role="separator"][data-axis="${axis}"]`));

  across.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: grid.boundaryPos("x", 1), clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  // A press with one already held: the release of the first was never seen.
  down.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: 100, clientY: grid.boundaryPos("y", 1), bubbles: true, button: 0, buttons: 1,
  }));
  assert.equal(across.dataset.dragging, undefined, "the first divider is let go");
  assert.equal(down.dataset.dragging, "true", "the second is held");

  window.document.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: 100, clientY: grid.boundaryPos("y", 1), bubbles: true, button: 0, buttons: 0,
  }));
  assert.equal(down.dataset.dragging, undefined, "and letting go clears it");
  view.destroy();
});

test("pressing a divider twice with the mouse centres the boundary", () => {
  const { window, host, grid, view } = mount();
  grid.setSize("card", "x", null);
  const divider = host.querySelector('[role="separator"]');
  const at = grid.boundaryPos("x", 1);
  grid.moveBoundary("x", 1, at + 200);
  view.render();
  assert.notEqual(grid.boundaryPos("x", 1), W / 2, "the boundary is off centre");

  const press = (t) => divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: grid.boundaryPos("x", 1), clientY: 100,
    bubbles: true, button: 0, buttons: 1,
  }));
  press();
  window.document.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: grid.boundaryPos("x", 1), clientY: 100, bubbles: true, button: 0, buttons: 0,
  }));
  press();
  assert.equal(grid.boundaryPos("x", 1), W / 2, "the second press centres it");
  view.destroy();
});

test("installTheme puts one stylesheet first in the head and reuses it", () => {
  const { window, view } = mount();
  const doc = window.document;
  const own = doc.createElement("style");
  own.textContent = ".card { color: red }";
  doc.head.append(own);

  const sheet = installTheme(doc);
  assert.equal(doc.head.firstElementChild, sheet, "before the host's own rules");
  assert.equal(sheet.textContent, themeCSS(), "and it holds the theme");
  assert.equal(installTheme(doc), sheet, "a second call reuses the one that is there");
  assert.equal(doc.querySelectorAll("style").length, 2, "and adds no second sheet");

  // 색과 크기를 직접 줄 수도 있다. 토큰 이름은 접두사를 따른다.
  const named = installTheme(doc, {
    prefix: "pane", palette: { line: "#123456" }, metrics: { gripLength: 40 },
  });
  assert.match(named.textContent, /--pane-line: #123456/);
  assert.match(named.textContent, /--pane-grip-length: 40px;/);
  view.destroy();
});

test("only the primary button drags a divider", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  const send = (type, button, buttons, x) =>
    divider.dispatchEvent(
      new window.PointerEvent(type, {
        pointerId: 3, clientX: x, clientY: 100, bubbles: true, isPrimary: true, button, buttons,
      }),
    );

  const at = grid.boundaryPos("x", 1);
  send("pointerdown", 2, 2, at);
  assert.equal(divider.dataset.dragging, undefined, "the second button does not hold the divider");
  send("pointermove", -1, 2, at + 150);
  assert.equal(grid.boundaryPos("x", 1), at, "and does not move the boundary");
  send("pointerup", 2, 0, at + 150);

  // A press of the second button is not the first press of a double press.
  grid.moveBoundary("x", 1, 300);
  view.render();
  send("pointerdown", 2, 2, 300);
  send("pointerup", 2, 0, 300);
  send("pointerdown", 0, 1, 300);
  assert.equal(grid.boundaryPos("x", 1), 300, "the primary press starts a drag, not a centring");
  send("pointerup", 0, 0, 300);
  view.destroy();
});

test("releasing another button leaves a mouse drag running", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  const at = grid.boundaryPos("x", 1);
  const doc = window.document;
  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: at, clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  doc.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: at + 100, clientY: 100, bubbles: true, buttons: 1,
  }));

  // The second button is pressed and released while the primary one is held.
  doc.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: at + 100, clientY: 100, bubbles: true, button: 2, buttons: 1,
  }));
  assert.equal(divider.dataset.dragging, "true", "the divider is still held");
  doc.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: at + 200, clientY: 100, bubbles: true, buttons: 1,
  }));
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - (at + 200)) < 1e-9,
    `it follows the pointer to ${grid.boundaryPos("x", 1)}, not ${at + 200}`,
  );

  doc.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: at + 200, clientY: 100, bubbles: true, button: 0, buttons: 0,
  }));
  assert.equal(divider.dataset.dragging, undefined, "the primary release ends the drag");
  view.destroy();
});

test("commit reports the rects the render writes", () => {
  const seen = [];
  const { window, host, grid, view } = mount({
    commit: (rects, draw) => {
      seen.push(rects);
      draw();
    },
  });
  const divider = host.querySelector('[role="separator"]');
  const at = grid.boundaryPos("x", 1);
  const doc = window.document;
  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: at, clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  // A fractional boundary, which is where the rect the grid computes and the
  // rect the element receives differ.
  doc.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: at + 30.7, clientY: 100, bubbles: true, buttons: 1,
  }));
  doc.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: at + 30.7, clientY: 100, bubbles: true, button: 0, buttons: 0,
  }));

  assert.ok(seen.length, "commit ran");
  const reported = seen[seen.length - 1];
  assert.notEqual(grid.rect("card").w, reported.get("card").w, "the drag left a fractional rect");
  for (const [id, rect] of reported) {
    const el = host.querySelector(`[data-card-id="${id}"]`);
    assert.equal(rect.x, parseFloat(el.style.left), `${id} left`);
    assert.equal(rect.y, parseFloat(el.style.top), `${id} top`);
    assert.equal(rect.w, parseFloat(el.style.width), `${id} width`);
    assert.equal(rect.h, parseFloat(el.style.height), `${id} height`);
  }
  view.destroy();
});

test("a card created later is drawn under the rules and the dividers", () => {
  const { host, grid, view } = mount();
  grid.split("card", "y");
  view.render();

  const kids = [...host.children];
  const lastCard = kids.findLastIndex((el) => el.dataset.cardId !== undefined);
  const firstOver = kids.findIndex((el) => el.dataset.cardId === undefined);
  assert.ok(lastCard >= 0 && firstOver >= 0, "the host holds cards and rules");
  assert.ok(
    firstOver > lastCard,
    `every card comes before every rule and divider, not ${kids.map((el) => el.className || "card").join(" ")}`,
  );
  view.destroy();
});

test("onChange reports a centring", () => {
  const changes = [];
  const { window, host, grid, view } = mount({ onChange: (reason) => changes.push(reason) });
  const divider = host.querySelector('[role="separator"]');
  grid.moveBoundary("x", 1, grid.boundaryPos("x", 1) - 200, false);
  view.render();
  changes.length = 0;

  // The second press of a pair centres the boundary.
  const at = grid.boundaryPos("x", 1);
  pointer(window, divider, "pointerdown", 7, at, 100);
  pointer(window, divider, "pointerup", 7, at, 100);
  pointer(window, divider, "pointerdown", 7, at, 100);
  assert.ok(changes.includes("center"), `the reasons were ${changes.join(" ") || "none"}`);
  pointer(window, divider, "pointerup", 7, grid.boundaryPos("x", 1), 100);
  view.destroy();
});

test("observeResize: false leaves the host unwatched", () => {
  const dom = new JSDOM("<!doctype html><div id=host></div>", { pretendToBeVisual: true });
  const { window } = dom;
  globalThis.document = window.document;
  const host = window.document.getElementById("host");
  let size = { w: 1000, h: 800 };
  Object.defineProperty(host, "clientWidth", { get: () => size.w, configurable: true });
  Object.defineProperty(host, "clientHeight", { get: () => size.h, configurable: true });

  // jsdom has no ResizeObserver, so this stub is the one the view finds.
  const watchers = [];
  globalThis.ResizeObserver = class {
    constructor(fn) { this.fn = fn; watchers.push(this); }
    observe() {}
    disconnect() {}
  };
  const view = (grid, options) =>
    new SoksakView(host, grid, {
      createCard: () => window.document.createElement("div"),
      ...options,
    });

  const unwatched = new Soksak(undefined, { width: size.w, height: size.h });
  const watched = new Soksak(undefined, { width: size.w, height: size.h });
  const off = view(unwatched, { observeResize: false });
  assert.equal(watchers.length, 0, "the view that refused it makes no observer");
  const on = view(watched, {});
  assert.equal(watchers.length, 1, "the view that did not makes one");

  size = { w: 600, h: 500 };
  watchers[0].fn();
  assert.equal(watched.width, 600, "the watched grid follows the host");
  assert.equal(unwatched.width, 1000, "the unwatched one does not");

  off.destroy();
  on.destroy();
  delete globalThis.ResizeObserver;
});

test("the sheet draws each part the README names", () => {
  const css = themeCSS();
  assert.match(
    css, /\.sp-rule\[data-virtual="true"\]\s*\{[^}]*--sp-line-crossing/,
    "the crossing part of a line is drawn fainter",
  );
  assert.match(css, /\.sp-divider::after\s*\{[^}]*--sp-grip\b/, "a grip is drawn inside the grab area");
  assert.match(css, /\.sp-divider\[data-axis="x"\]\s*\{[^}]*cursor:\s*col-resize/, "the x axis has its cursor");
  assert.match(css, /\.sp-divider\[data-axis="y"\]\s*\{[^}]*cursor:\s*row-resize/, "the y axis has its cursor");
});

test("a destroyed view does not run the commit hook", () => {
  const seen = [];
  const { view } = mount({
    commit: (rects, draw) => {
      seen.push(rects.size);
      draw();
    },
  });
  view.destroy();
  seen.length = 0;
  view.render();
  assert.deepEqual(seen, [], "the host is told nothing about a plane that is gone");
});

test("a drag the release never reached is not the first press of a pair", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  const doc = window.document;
  const at = grid.boundaryPos("x", 1);

  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: at, clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  doc.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: at + 300, clientY: 100, bubbles: true, buttons: 1,
  }));
  const moved = grid.boundaryPos("x", 1);
  assert.notEqual(moved, at, "the drag moved the boundary");

  // The release itself was never delivered. The next move reports no button.
  doc.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: at + 300, clientY: 100, bubbles: true, buttons: 0,
  }));
  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: at + 300, clientY: 100, bubbles: true, button: 0, buttons: 1,
  }));
  assert.equal(grid.boundaryPos("x", 1), moved, "the next press starts a drag, it does not centre");
  doc.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: at + 300, clientY: 100, bubbles: true, button: 0, buttons: 0,
  }));
  view.destroy();
});

test("a pointer drag the release never reached is not the first press of a pair", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  const at = grid.boundaryPos("x", 1);

  pointer(window, divider, "pointerdown", 9, at, 100);
  pointer(window, divider, "pointermove", 9, at + 300, 100);
  const moved = grid.boundaryPos("x", 1);
  assert.notEqual(moved, at, "the drag moved the boundary");

  divider.dispatchEvent(new window.PointerEvent("pointermove", {
    pointerId: 9, clientX: at + 300, clientY: 100, bubbles: true, isPrimary: true, button: -1, buttons: 0,
  }));
  pointer(window, divider, "pointerdown", 9, at + 300, 100);
  assert.equal(grid.boundaryPos("x", 1), moved, "the next press starts a drag, it does not centre");
  pointer(window, divider, "pointerup", 9, at + 300, 100);
  view.destroy();
});
