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
      // The view writes `data-card-id` itself. A card element the test stamps
      // makes every check of that attribute read what the test wrote.
      return window.document.createElement("div");
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
    view.render();                                 // the host draws the change it made
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
  view.render();                                // the host draws the change it made

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

test("releasing the mouse folds a pair the drag brought together", () => {
  // The pointer path is held above. A host that delivers a press as mouse
  // events reaches the same fold through its own release, and a merge the
  // mouse never performs leaves two lines where the drag put one.
  const reasons = [];
  const { window, host, grid, view } = mount({ onChange: (reason) => reasons.push(reason) });
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
  el.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: from, clientY: 300, bubbles: true, button: 0, buttons: 1,
  }));
  window.document.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: onto - 2, clientY: 300, bubbles: true, buttons: 1,   // inside snapDistance
  }));
  reasons.length = 0;
  window.document.dispatchEvent(new window.MouseEvent("mouseup", {
    clientX: onto - 2, clientY: 300, bubbles: true, button: 0, buttons: 0,
  }));

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
  assert.match(
    css,
    /\.sp-divider:hover::after,\s*\.sp-divider:focus-visible::after,\s*\.sp-divider\[data-dragging\]::after\s*\{[^}]*--sp-grip-active/,
    "and it takes the active colour while the divider is hovered, focused or held",
  );
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

test("a press with the pointer that is still down is not the second press of a pair", () => {
  // No release and no move reporting the button gone, so the press below finds
  // its own drag still running. Dropping that drag opens the pair again: the
  // press starts a drag, and centring here would undo the drag before it.
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  grid.moveBoundary("x", 1, 400, false);
  view.render();
  const off = grid.boundaryPos("x", 1);

  pointer(window, divider, "pointerdown", 9, off, 100);
  pointer(window, divider, "pointermove", 9, off - 100, 100);
  const moved = grid.boundaryPos("x", 1);
  assert.notEqual(moved, off, "the drag moved the boundary");

  pointer(window, divider, "pointerdown", 9, moved, 100);
  assert.equal(grid.boundaryPos("x", 1), moved, "the next press starts a drag, it does not centre");
  pointer(window, divider, "pointerup", 9, moved, 100);
  view.destroy();
});

test("a resize under a drag carries the drag with it", () => {
  const dom = new JSDOM("<!doctype html><div id=host></div>", { pretendToBeVisual: true });
  const { window } = dom;
  globalThis.document = window.document;
  const host = window.document.getElementById("host");
  let fire = () => {};
  globalThis.ResizeObserver = class {
    constructor(cb) { fire = cb; }
    observe() {}
    disconnect() { fire = () => {}; }
  };
  const size = (w, h) => {
    Object.defineProperty(host, "clientWidth", { value: w, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: h, configurable: true });
  };

  size(1200, 600);
  const grid = new Soksak(undefined, { width: 1200, height: 600, gap: 24 });
  grid.split("card", "x");
  const view = new SoksakView(host, grid, {
    createCard: () => window.document.createElement("div"),
  });
  view.render();
  const divider = host.querySelector('[role="separator"]');
  const at = grid.boundaryPos("x", 1);

  pointer(window, divider, "pointerdown", 1, at, 300);
  pointer(window, divider, "pointermove", 1, at + 100, 300);
  const moved = grid.boundaryPos("x", 1);

  // The host shrinks while the finger is still down. The boundary moves with the
  // plane, and the drag holds the position it was pressed at.
  size(800, 600);
  fire();
  const carried = grid.boundaryPos("x", 1);
  assert.notEqual(carried, moved, "the resize moved the boundary");

  pointer(window, divider, "pointermove", 1, at + 130, 300);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - (carried + 30)) < 1e-6,
    `the next move goes 30 further, to ${grid.boundaryPos("x", 1)}, not ${carried + 30}`,
  );

  pointer(window, divider, "pointerup", 1, at + 130, 300);
  view.destroy();
  delete globalThis.ResizeObserver;
});

test("a second finger on a held divider is not the second press of a pair", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  grid.moveBoundary("x", 1, 400, false);
  view.render();

  const off = grid.boundaryPos("x", 1);
  pointer(window, divider, "pointerdown", 11, off, 150);
  pointer(window, divider, "pointerdown", 12, off, 320);
  assert.equal(grid.boundaryPos("x", 1), off, "the boundary is not centred");

  pointer(window, divider, "pointerup", 11, off, 150);
  pointer(window, divider, "pointerup", 12, off, 320);
  view.destroy();
});

test("a press on another divider drops the drag whose release was never delivered", () => {
  const { window, host, grid, view } = mount();
  grid.split("card", "y");
  view.render();
  const [across, down] = [
    host.querySelector('.sp-divider[data-axis="x"]'),
    host.querySelector('.sp-divider[data-axis="y"]'),
  ];
  assert.ok(across && down, "the plane has a divider on each axis");

  pointer(window, across, "pointerdown", 1, grid.boundaryPos("x", 1), 300);
  assert.equal(across.dataset.dragging, "true", "the first divider is held");

  // The release of the first press was never delivered.
  pointer(window, down, "pointerdown", 1, 300, grid.boundaryPos("y", 1));
  assert.equal(across.dataset.dragging, undefined, "the first divider is let go");
  assert.equal(down.dataset.dragging, "true", "and the second is held");
  assert.equal(host.querySelectorAll("[data-dragging]").length, 1, "one divider is held");

  pointer(window, down, "pointerup", 1, 300, grid.boundaryPos("y", 1));
  view.destroy();
});

test("a divider two pointers hold stays held until the last one lets go", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  const at = grid.boundaryPos("x", 1);

  pointer(window, divider, "pointerdown", 1, at, 150);
  pointer(window, divider, "pointerdown", 2, at, 320);
  assert.equal(divider.dataset.dragging, "true", "both hold it");

  pointer(window, divider, "pointerup", 1, at, 150);
  assert.equal(divider.dataset.dragging, "true", "one let go, the other still holds it");
  pointer(window, divider, "pointermove", 2, at + 60, 320);
  assert.ok(Math.abs(grid.boundaryPos("x", 1) - (at + 60)) < 1e-6, "and still drives it");

  pointer(window, divider, "pointerup", 2, at + 60, 320);
  assert.equal(divider.dataset.dragging, undefined, "the last release lets it go");
  view.destroy();
});

test("a hold whose release never arrived does not stop the divider being centred", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  grid.moveBoundary("x", 1, 400, false);
  view.render();
  const centre = 600;

  // This press is never released: the divider stays held for the life of the
  // plane. A double press on it is still a double press.
  pointer(window, divider, "pointerdown", 7, grid.boundaryPos("x", 1), 150);
  pointer(window, divider, "pointerdown", 8, grid.boundaryPos("x", 1), 150);
  pointer(window, divider, "pointerup", 8, grid.boundaryPos("x", 1), 150);
  pointer(window, divider, "pointerdown", 9, grid.boundaryPos("x", 1), 150);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - centre) < 1e-6,
    `the pair centres the boundary, at ${grid.boundaryPos("x", 1)} instead of ${centre}`,
  );

  pointer(window, divider, "pointerup", 9, centre, 150);
  pointer(window, divider, "pointerup", 7, centre, 150);
  view.destroy();
});

test("a drag that passes a line no card reads keeps the divider it holds", () => {
  const { window, host, grid, view } = mount();
  grid.split("card", "y");
  grid.close("card");
  grid.split("card-1", "x");
  grid.split("card-2", "y");
  grid.split("card-2", "y");
  grid.close("card-2");
  view.render();
  assert.equal(grid.isVirtual("y", 1), true, "line 1 is read by no card");

  const divider = host.querySelector('.sp-divider[data-axis="y"][data-line="2"]');
  assert.ok(divider, "the boundary on line 2 has a grab area");
  const at = grid.boundaryPos("y", 2);
  const past = grid.boundaryPos("y", 1) - 30;

  pointer(window, divider, "pointerdown", 1, 300, at);
  pointer(window, divider, "pointermove", 1, 300, past);
  assert.equal(grid.lines("y").length, 3, "the line the move passed is gone");
  assert.ok(host.contains(divider), "the gesture still holds its element");
  assert.equal(divider.dataset.dragging, "true", "and the element is still held");
  assert.equal(divider.dataset.line, "1", "filed under the line the boundary now has");

  // The drag keeps driving the boundary, down to where the range stops it.
  const target = grid.boundaryPos("y", 1) - 20;
  pointer(window, divider, "pointermove", 1, 300, target);
  const floor = grid.boundaryRange("y", 1)[0];
  assert.ok(
    Math.abs(grid.boundaryPos("y", 1) - Math.max(floor, target)) < 1e-9,
    `it follows to ${grid.boundaryPos("y", 1)}, not ${Math.max(floor, target)}`,
  );

  pointer(window, divider, "pointerup", 1, 300, target);
  assert.equal(divider.dataset.dragging, undefined, "the release lets it go");
  assert.equal(
    host.querySelectorAll(".sp-divider").length,
    grid.dividers().length,
    "one element per divider",
  );
  view.destroy();
});

test("the view places elements on the display's pixel grid", () => {
  // A display that draws two pixels per unit has a grid half a unit fine, so a
  // fractional edge lands on a half. The step is read from the window the host
  // is in: a view that reads no ratio rounds to a whole unit instead.
  let reported = null;
  const { window, grid, view } = mount({
    commit: (rects, draw) => {
      reported = rects;
      draw();
    },
  });
  grid.moveBoundary("x", 1, 300.3);
  for (const [ratio, written] of [
    [1, "288px"],
    [2, "288.5px"],
  ]) {
    Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true });
    view.render();
    assert.equal(view.element("card").style.width, written, `written at a ratio of ${ratio}`);
    assert.equal(reported.get("card").w, parseFloat(written), `commit reports it at ${ratio}`);
  }
  view.destroy();
});

/**
 * Two boundaries on one axis, with a line no card reads below both.
 *
 * A move that passes that line drops it, which renumbers the boundary above.
 */
function stacked() {
  const it = mount();
  it.grid.split("card", "y");
  const spare = it.grid.split("card", "x");
  it.grid.close(spare);
  it.grid.split("card-1", "x");
  it.view.render();
  assert.equal(it.grid.isVirtual("x", 1), true, "line 1 is read by no card");
  return it;
}

test("a drag past a line no card reads keeps the divider another finger holds", () => {
  const { window, host, grid, view } = stacked();
  const near = host.querySelector('.sp-divider[data-axis="x"][data-line="2"]');
  const far = host.querySelector('.sp-divider[data-axis="x"][data-line="3"]');

  // The second finger takes the boundary above and holds it.
  pointer(window, far, "pointerdown", 2, grid.boundaryPos("x", 3), 300);
  pointer(window, far, "pointermove", 2, grid.boundaryPos("x", 3) + 10, 300);
  const held = grid.boundaryPos("x", 3);

  // The first finger takes the boundary below past the line no card reads.
  pointer(window, near, "pointerdown", 1, grid.boundaryPos("x", 2), 100);
  pointer(window, near, "pointermove", 1, grid.boundaryPos("x", 1) - 20, 100);
  assert.equal(grid.lines("x").length, 4, "the line the move passed is gone");

  assert.equal(far.isConnected, true, "the second finger still holds its element");
  assert.equal(far.dataset.dragging, "true", "and the element is still held");
  assert.equal(far.dataset.line, "2", "filed under the line its boundary now has");

  pointer(window, far, "pointermove", 2, held + 60, 300);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 2) - (held + 60)) < 1e-6,
    `it still drives its own boundary, to ${grid.boundaryPos("x", 2)} and not ${held + 60}`,
  );
  view.destroy();
});

test("a merge on release keeps the divider another finger holds", () => {
  const { window, host, grid, view } = stacked();
  const near = host.querySelector('.sp-divider[data-axis="x"][data-line="2"]');
  const far = host.querySelector('.sp-divider[data-axis="x"][data-line="3"]');

  pointer(window, far, "pointerdown", 2, grid.boundaryPos("x", 3), 300);
  pointer(window, far, "pointermove", 2, grid.boundaryPos("x", 3) + 10, 300);
  const held = grid.boundaryPos("x", 3);

  // The boundary below snaps onto the line no card reads, and the release folds
  // the pair into one line, which renumbers the boundary above.
  const onto = grid.boundaryPos("x", 1);
  pointer(window, near, "pointerdown", 1, grid.boundaryPos("x", 2), 100);
  pointer(window, near, "pointermove", 1, onto + 2, 100);
  pointer(window, near, "pointerup", 1, onto + 2, 100);
  assert.equal(grid.lines("x").length, 4, "the pair was folded into one line");

  assert.equal(far.isConnected, true, "the second finger still holds its element");
  assert.equal(far.dataset.dragging, "true", "and the element is still held");

  pointer(window, far, "pointermove", 2, held + 60, 300);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 2) - (held + 60)) < 1e-6,
    `it still drives its own boundary, to ${grid.boundaryPos("x", 2)} and not ${held + 60}`,
  );
  view.destroy();
});

test("a drag on one axis keeps the divider a finger holds on the other", () => {
  const { window, host, grid, view } = mount();
  // One card across the top, two side by side below it, and a line no card
  // reads inside the top card. A divider's key carries where its stretch starts
  // on the other axis, so dropping that line renumbers the key of the vertical
  // divider as well.
  grid.replace({
    xs: [0, 0.5, 1],
    ys: [0, 0.25, 0.5, 1],
    cards: [
      { id: "top", c0: 0, c1: 2, r0: 0, r1: 2 },
      { id: "left", c0: 0, c1: 1, r0: 2, r1: 3 },
      { id: "right", c0: 1, c1: 2, r0: 2, r1: 3 },
    ],
    paidBy: {},
  });
  view.render();
  assert.equal(grid.isVirtual("y", 1), true, "line 1 is read by no card");
  const down = host.querySelector('.sp-divider[data-axis="x"]');
  const across = host.querySelector('.sp-divider[data-axis="y"]');

  pointer(window, down, "pointerdown", 1, 600, 450);
  pointer(window, down, "pointermove", 1, 610, 450);
  const held = grid.boundaryPos("x", 1);

  pointer(window, across, "pointerdown", 2, 600, 300);
  pointer(window, across, "pointermove", 2, 600, 140);
  assert.equal(grid.lines("y").length, 3, "the line the move passed is gone");

  assert.equal(down.isConnected, true, "the first finger still holds its element");
  assert.equal(down.dataset.dragging, "true", "and the element is still held");

  pointer(window, down, "pointermove", 1, held + 50, 450);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - (held + 50)) < 1e-6,
    `it still drives its own boundary, to ${grid.boundaryPos("x", 1)} and not ${held + 50}`,
  );
  view.destroy();
});

test("a key past a line no card reads keeps the divider under the focus", () => {
  const { window, host, grid, view } = mount();
  grid.split("card", "y");
  grid.close("card");
  grid.split("card-1", "x");
  grid.split("card-2", "y");
  grid.split("card-2", "y");
  grid.close("card-2");
  view.render();
  assert.equal(grid.isVirtual("y", 1), true, "line 1 is read by no card");

  const divider = host.querySelector('.sp-divider[data-axis="y"][data-line="2"]');
  const key = (name) =>
    window.document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
    );

  divider.focus();
  for (let i = 0; i < 19; i++) key("ArrowUp");
  assert.equal(grid.lines("y").length, 3, "the line the keys passed is gone");

  assert.equal(divider.isConnected, true, "the divider under the focus is still there");
  assert.equal(divider.dataset.line, "1", "filed under the line its boundary now has");
  assert.equal(window.document.activeElement, divider, "and it still has the focus");

  const at = grid.boundaryPos("y", 1);
  assert.ok(at - 8 > grid.boundaryRange("y", 1)[0], "the boundary has room for another step");
  key("ArrowUp");
  assert.equal(grid.boundaryPos("y", 1), at - 8, "and the next key moves it");
  view.destroy();
});

test("onChange reports a centring driven by the mouse", () => {
  const changes = [];
  const { window, host, grid, view } = mount({ onChange: (reason) => changes.push(reason) });
  grid.setSize("card", "x", null);
  const divider = host.querySelector('[role="separator"]');
  grid.moveBoundary("x", 1, grid.boundaryPos("x", 1) + 200, false);
  view.render();
  changes.length = 0;

  const press = () =>
    divider.dispatchEvent(
      new window.MouseEvent("mousedown", {
        clientX: grid.boundaryPos("x", 1),
        clientY: 100,
        bubbles: true,
        button: 0,
        buttons: 1,
      }),
    );
  press();
  window.document.dispatchEvent(
    new window.MouseEvent("mouseup", {
      clientX: grid.boundaryPos("x", 1),
      clientY: 100,
      bubbles: true,
      button: 0,
      buttons: 0,
    }),
  );
  press();
  assert.equal(grid.boundaryPos("x", 1), 600, "the second press centres it");
  assert.ok(changes.includes("center"), `the reasons were ${changes.join(" ") || "none"}`);
  view.destroy();
});

test("onChange reports a centring driven by a key", () => {
  const changes = [];
  const { window, host, grid, view } = mount({ onChange: (reason) => changes.push(reason) });
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  grid.moveBoundary("x", 1, grid.boundaryPos("x", 1) + 200, false);
  view.render();
  changes.length = 0;

  el.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  assert.equal(grid.boundaryPos("x", 1), 600, "the key centres it");
  assert.ok(changes.includes("center"), `the reasons were ${changes.join(" ") || "none"}`);
  view.destroy();
});

test("a divider a finger still holds keeps data-dragging when the mouse lets go", () => {
  const { window, host, grid, view } = mount();
  const divider = host.querySelector('[role="separator"]');
  const at = grid.boundaryPos("x", 1);

  pointer(window, divider, "pointerdown", 1, at, 150);
  divider.dispatchEvent(
    new window.MouseEvent("mousedown", {
      clientX: at,
      clientY: 150,
      bubbles: true,
      button: 0,
      buttons: 1,
    }),
  );
  assert.equal(divider.dataset.dragging, "true", "the finger and the mouse both hold it");

  window.document.dispatchEvent(
    new window.MouseEvent("mouseup", {
      clientX: at,
      clientY: 150,
      bubbles: true,
      button: 0,
      buttons: 0,
    }),
  );
  assert.equal(divider.dataset.dragging, "true", "the finger still holds it");

  pointer(window, divider, "pointerup", 1, at, 150);
  assert.equal(divider.dataset.dragging, undefined, "the last release lets it go");
  view.destroy();
});

test("a change on one stretch of a line carries the anchor of a gesture on the other", () => {
  const { window, host, grid, view } = mount();
  // A card spanning the line breaks it into two stretches, so two gestures hold
  // one boundary through two elements.
  grid.replace({
    xs: [0, 0.5, 1],
    ys: [0, 1 / 3, 2 / 3, 1],
    cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "band", c0: 0, c1: 2, r0: 1, r1: 2 },
      { id: "c", c0: 0, c1: 1, r0: 2, r1: 3 },
      { id: "d", c0: 1, c1: 2, r0: 2, r1: 3 },
    ],
    paidBy: {},
  });
  view.render();
  const both = [...host.querySelectorAll('.sp-divider[data-axis="x"][data-line="1"]')].sort(
    (p, q) => parseFloat(p.style.top) - parseFloat(q.style.top),
  );
  assert.equal(both.length, 2, "the line is drawn as two stretches");
  const [upper, lower] = both;

  const at = grid.boundaryPos("x", 1);
  pointer(window, upper, "pointerdown", 1, at, 60);
  lower.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
  );
  const moved = grid.boundaryPos("x", 1);
  assert.equal(moved, at + 8, "the key moved the boundary both gestures hold");

  // The finger has not moved, so its next move leaves the boundary where it is.
  pointer(window, upper, "pointermove", 1, at, 60);
  assert.equal(
    grid.boundaryPos("x", 1),
    moved,
    "the finger drives the boundary from where the key left it",
  );
  view.destroy();
});

test("two stretches that become one divider stay with the gesture that kept it", () => {
  const { window, host, grid, view } = mount();
  grid.replace({
    xs: [0, 0.5, 1],
    ys: [0, 1 / 3, 2 / 3, 1],
    cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "band", c0: 0, c1: 2, r0: 1, r1: 2 },
      { id: "c", c0: 0, c1: 1, r0: 2, r1: 3 },
      { id: "d", c0: 1, c1: 2, r0: 2, r1: 3 },
    ],
    paidBy: {},
  });
  view.render();
  const both = [...host.querySelectorAll('.sp-divider[data-axis="x"][data-line="1"]')].sort(
    (p, q) => parseFloat(p.style.top) - parseFloat(q.style.top),
  );
  const [upper, lower] = both;
  const at = grid.boundaryPos("x", 1);
  pointer(window, upper, "pointerdown", 1, at, 60);
  pointer(window, lower, "pointerdown", 2, at, 500);

  // The band is cut on the same line, so the two stretches become one divider.
  grid.split("band", "x");
  view.render();
  assert.equal(
    host.querySelectorAll('.sp-divider[data-axis="x"][data-line="1"]').length,
    1,
    "one divider is left on the line",
  );
  assert.equal(upper.isConnected, true, "the gesture whose element kept its key keeps it");
  assert.equal(upper.dataset.dragging, "true", "and the element is still held");
  assert.equal(lower.isConnected, false, "the other element is taken away");
  view.destroy();
});

test("a re-filed divider takes the stretch it covers most, not the one it starts in", () => {
  // The commit hook lets a host hold the draw, so two moves can land in one
  // paint. One takes a stretch's start past where the element it holds is drawn;
  // the other renumbers that stretch's key. Only the length the element covers
  // then says which stretch is its own.
  let hold = false;
  let pending = null;
  const { window, host, grid, view } = mount({
    commit: (_rects, draw) => {
      if (hold) pending = draw;
      else draw();
    },
  });
  grid.replace({
    xs: [0, 0.5, 1],
    ys: [0, 0.2, 0.25, 0.4, 0.7, 1],
    cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 2 },
      { id: "b", c0: 1, c1: 2, r0: 0, r1: 2 },
      { id: "band", c0: 0, c1: 2, r0: 2, r1: 3 },
      { id: "c", c0: 0, c1: 1, r0: 3, r1: 5 },
      { id: "d", c0: 1, c1: 2, r0: 3, r1: 5 },
    ],
    paidBy: {},
  });
  view.render();
  assert.deepEqual([1, 4].filter((k) => grid.isVirtual("y", k)), [1, 4], "two lines no card reads");
  const down = [...host.querySelectorAll('.sp-divider[data-axis="x"][data-line="1"]')].sort(
    (p, q) => parseFloat(p.style.top) - parseFloat(q.style.top),
  );
  assert.equal(down.length, 2, "the vertical line is drawn as two stretches");
  const lower = down[1];
  const [top, bottom] = [...host.querySelectorAll('.sp-divider[data-axis="y"]')].sort(
    (p, q) => parseFloat(p.style.top) - parseFloat(q.style.top),
  );

  // A finger holds the lower stretch and never moves.
  pointer(window, lower, "pointerdown", 3, grid.boundaryPos("x", 1), 500);
  const was = parseFloat(lower.style.top);

  hold = true;
  // The lower stretch's start goes past where that element is drawn.
  pointer(window, bottom, "pointerdown", 2, 600, grid.boundaryPos("y", 3));
  pointer(window, bottom, "pointermove", 2, 600, 450);
  // And this renumbers its key, so the element has to be filed again.
  pointer(window, top, "pointerdown", 1, 600, grid.boundaryPos("y", 2));
  pointer(window, top, "pointermove", 1, 600, 100);
  hold = false;
  pending();

  const mine = grid.dividers().find((d) => d.key === "x:1:2");
  assert.ok(mine.y > was, "the stretch now starts past where the element was drawn");
  assert.equal(view.drags.has(3), true, "the finger still holds its divider");
  assert.equal(lower.isConnected, true, "and its element is still in the host");
  assert.equal(lower.dataset.line, "1");
  assert.equal(
    parseFloat(lower.style.top),
    Math.round(mine.y),
    "and it is drawn on the stretch it covers, not on the one above it",
  );
  view.destroy();
});

test("a re-filed divider keeps the stretch it overlaps, not the one it only reaches toward", () => {
  // The other way round. The stretch the element belongs to comes up and
  // shrinks, so the element reaches past its foot, and a second stretch stands
  // further down that the element does not reach at all. The overlap has to be
  // measured from where the two meet, not from whichever starts first.
  let hold = false;
  let pending = null;
  const { window, host, grid, view } = mount({
    commit: (_rects, draw) => {
      if (hold) pending = draw;
      else draw();
    },
  });
  grid.replace({
    xs: [0, 0.5, 1],
    ys: [0, 0.2, 0.25, 2 / 3, 23 / 30, 1], // 0 120 150 400 460 600
    cards: [
      { id: "band0", c0: 0, c1: 2, r0: 0, r1: 2 },
      { id: "p", c0: 0, c1: 1, r0: 2, r1: 3 },
      { id: "q", c0: 1, c1: 2, r0: 2, r1: 3 },
      { id: "band1", c0: 0, c1: 2, r0: 3, r1: 4 },
      { id: "u", c0: 0, c1: 1, r0: 4, r1: 5 },
      { id: "v", c0: 1, c1: 2, r0: 4, r1: 5 },
    ],
    paidBy: {},
  });
  view.render();
  assert.deepEqual([1, 2, 3, 4].filter((k) => grid.isVirtual("y", k)), [1], "one line no card reads");
  const near = [...host.querySelectorAll('.sp-divider[data-axis="x"][data-line="1"]')].sort(
    (a, b) => parseFloat(a.style.top) - parseFloat(b.style.top),
  )[0];
  const [head, foot] = [...host.querySelectorAll('.sp-divider[data-axis="y"]')].sort(
    (a, b) => parseFloat(a.style.top) - parseFloat(b.style.top),
  );

  // A finger holds the upper stretch and never moves.
  pointer(window, near, "pointerdown", 3, grid.boundaryPos("x", 1), 300);
  const reaches = parseFloat(near.style.top) + parseFloat(near.style.height);

  hold = true;
  // The stretch's foot comes up, so the element reaches past it.
  pointer(window, foot, "pointerdown", 2, 600, grid.boundaryPos("y", 3));
  pointer(window, foot, "pointermove", 2, 600, 280);
  // And its head comes up past the line no card reads, which renumbers its key.
  pointer(window, head, "pointerdown", 1, 600, grid.boundaryPos("y", 2));
  pointer(window, head, "pointermove", 1, 600, 110);
  hold = false;
  pending();

  const own = grid.dividers().find((d) => d.key === "x:1:1");
  const other = grid.dividers().find((d) => d.key === "x:1:3");
  assert.ok(own.y + own.h < reaches, "the element reaches past the foot of its own stretch");
  assert.ok(other.y > reaches, "and does not reach the other stretch at all");
  assert.equal(view.drags.has(3), true, "the finger still holds a divider");
  assert.equal(
    parseFloat(near.style.top),
    Math.round(own.y),
    "and it is the one it overlaps, not the one further down",
  );
  view.destroy();
});

test("a re-filed divider takes the stretch it covers most when it covers two", () => {
  // A rail cuts the stretch the element holds in two, and a split above it
  // renumbers the key. Two changes the host makes before one render, which is
  // how a host batches. The element covers part of both halves, so how much of
  // each it covers is what picks one.
  const { window, host, grid, view } = mount();
  grid.replace({
    xs: [0, 0.5, 1],
    ys: [0, 0.42, 0.64, 1],
    cards: [
      { id: "band", c0: 0, c1: 2, r0: 0, r1: 1 },
      { id: "p1", c0: 0, c1: 1, r0: 1, r1: 2 },
      { id: "q1", c0: 1, c1: 2, r0: 1, r1: 2 },
      { id: "p2", c0: 0, c1: 1, r0: 2, r1: 3 },
      { id: "q2", c0: 1, c1: 2, r0: 2, r1: 3 },
    ],
    paidBy: {},
  });
  view.render();
  const down = [...host.querySelectorAll('.sp-divider[data-axis="x"]')];
  assert.equal(down.length, 1, "the vertical line is drawn as one stretch");
  const el = down[0];
  pointer(window, el, "pointerdown", 1, grid.boundaryPos("x", 1), 500);
  const from = parseFloat(el.style.top);
  const to = from + parseFloat(el.style.height);

  assert.equal(grid.canInsertAt("y", 2), true, "a rail can stand between the two pairs");
  assert.ok(grid.insertAt("y", 2, { id: "rail", size: 40 }), "it cuts the stretch in two");
  assert.ok(grid.split("band", "y"), "and this renumbers what is left of the key");

  const halves = grid.dividers().filter((d) => d.axis === "x" && d.line === 1);
  assert.equal(halves.length, 2, "the stretch it held is now two");
  const over = halves.map((d) => Math.min(to, d.y + d.h) - Math.max(from, d.y));
  assert.ok(over[0] > 0 && over[1] > 0, `the element covers part of both: ${over}`);
  const most = over[0] > over[1] ? halves[0] : halves[1];

  view.render();
  assert.equal(view.drags.has(1), true, "the finger still holds a divider");
  assert.equal(
    parseFloat(el.style.top),
    Math.round(most.y),
    "and it is the half it covers most, not the first half it touches",
  );
  view.destroy();
});

test("a gesture ends when a change the host makes takes its boundary away", () => {
  const { window, host, grid, view } = mount();
  grid.replace({
    xs: [0, 0.4, 1],
    ys: [0, 1],
    cards: [
      { id: "left", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "right", c0: 1, c1: 2, r0: 0, r1: 1 },
    ],
    paidBy: {},
  });
  view.render();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const held = grid.boundaryPos("x", 1);
  pointer(window, el, "pointerdown", 1, held, 300);
  assert.equal(el.dataset.dragging, "true", "the finger has the divider");

  // The host cuts the card on the left. A line goes in below the one the finger
  // holds, so that number names the new boundary and the divider is drawn there.
  grid.split("left", "x");
  view.render();
  assert.ok(parseFloat(el.style.left) < held - 100, "the divider is drawn somewhere else");
  assert.equal(el.dataset.dragging, undefined, "so nothing holds it any more");

  const was = grid.rect("left").w;
  pointer(window, el, "pointermove", 1, held + 100, 300);
  assert.equal(grid.rect("left").w, was, "and the next move drives no boundary at all");
  view.destroy();
});

test("a gesture ends when a card the host puts in shifts the boundary it holds", () => {
  const { window, host, grid, view } = mount();
  grid.replace({
    xs: [0, 0.4, 1],
    ys: [0, 1],
    cards: [
      { id: "left", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "right", c0: 1, c1: 2, r0: 0, r1: 1 },
    ],
    paidBy: {},
  });
  view.render();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const held = grid.boundaryPos("x", 1);
  pointer(window, el, "pointerdown", 1, held, 300);

  // A card that reaches across the plane goes in at the border, and every card
  // past it is shifted by its span.
  assert.ok(grid.insertAt("x", 0, { id: "rail", size: 190 }), "the rail went in");
  view.render();
  assert.equal(el.dataset.dragging, undefined, "nothing holds the divider any more");

  const was = grid.rect("rail").w;
  pointer(window, el, "pointermove", 1, held + 100, 300);
  assert.equal(grid.rect("rail").w, was, "and the next move does not resize the card that arrived");
  view.destroy();
});

test("a gesture survives a change that leaves its boundary where it stands", () => {
  const { window, host, grid, view } = mount();
  grid.replace({
    xs: [0, 0.4, 1],
    ys: [0, 1],
    cards: [
      { id: "left", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "right", c0: 1, c1: 2, r0: 0, r1: 1 },
    ],
    paidBy: {},
  });
  view.render();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const held = grid.boundaryPos("x", 1);
  pointer(window, el, "pointerdown", 1, held, 300);

  // The cut goes in above the line the finger holds, so a line is added and
  // that line keeps both its number and its place.
  grid.split("right", "x");
  view.render();
  assert.equal(grid.boundaryPos("x", 1), held, "the boundary is where it was");
  assert.equal(el.dataset.dragging, "true", "so the finger still has it");

  pointer(window, el, "pointermove", 1, held + 100, 300);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - (held + 100)) < 1e-6,
    `it goes on driving its own boundary, to ${grid.boundaryPos("x", 1)}`,
  );
  view.destroy();
});

test("a host that renders between a drag and the draw it is holding keeps the drag", () => {
  let hold = false;
  let pending = null;
  const { window, host, grid, view } = mount({
    commit: (_rects, draw) => {
      if (hold) pending = draw;
      else draw();
    },
  });
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const held = grid.boundaryPos("x", 1);
  pointer(window, el, "pointerdown", 1, held, 300);

  hold = true;
  pointer(window, el, "pointermove", 1, held + 300, 300);
  assert.equal(grid.boundaryPos("x", 1), held + 300, "the drag moved it, and nothing is drawn yet");
  view.render(); // the host renders for reasons of its own
  assert.equal(el.dataset.dragging, "true", "the change was the view's own, so the gesture stands");

  hold = false;
  pending();
  pointer(window, el, "pointermove", 1, held + 380, 300);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - (held + 380)) < 1e-6,
    `and it goes on driving its own boundary, to ${grid.boundaryPos("x", 1)}`,
  );
  view.destroy();
});

test("a gesture the host's change ends does not leave the next press centring", () => {
  const { window, host, grid, view } = mount();
  grid.replace({
    xs: [0, 0.4, 1],
    ys: [0, 1],
    cards: [
      { id: "left", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "right", c0: 1, c1: 2, r0: 0, r1: 1 },
    ],
    paidBy: {},
  });
  view.render();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const held = grid.boundaryPos("x", 1);
  pointer(window, el, "pointerdown", 1, held, 300);
  pointer(window, el, "pointermove", 1, held + 120, 300);

  // The host puts in a card that reaches across the plane. The boundary the
  // finger holds moves further than the divider is grabbed at, so the gesture
  // ends — and the element stays in the host, unlike one the sweep takes away.
  assert.ok(grid.insertAt("x", 0, { id: "rail", size: 190 }), "the rail went in");
  view.render();
  assert.equal(el.dataset.dragging, undefined, "nothing holds the divider any more");
  pointer(window, el, "pointerup", 1, held + 120, 300);

  // The press that moved the boundary is not the first press of a pair.
  const at = grid.boundaryPos("x", 1);
  pointer(window, el, "pointerdown", 1, at, 300);
  assert.equal(grid.boundaryPos("x", 1), at, "the next press takes hold, it does not centre");
  assert.equal(el.dataset.dragging, "true", "and the divider is held again");
  pointer(window, el, "pointerup", 1, at, 300);
  view.destroy();
});

test("a change smaller than the width a divider is grabbed at keeps the gesture", () => {
  const { window, host, grid, view } = mount();
  // The reach is the width the divider is grabbed at, which is the larger of the
  // gap and grabSize. 16 is inside that and outside the smaller of the two.
  assert.equal(grid.gap, 24);
  assert.equal(grid.grabSize, 11);
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const at = grid.boundaryPos("x", 1);
  pointer(window, el, "pointerdown", 1, at, 300);

  // The host moves the boundary itself, so the view is told of it by the render.
  grid.moveBoundary("x", 1, at + 16, false);
  const moved = grid.boundaryPos("x", 1);
  assert.ok(Math.abs(moved - (at + 16)) < 1e-6, `the host moved the boundary 16, to ${moved}`);
  view.render();
  assert.equal(el.dataset.dragging, "true", "16 is inside the grab width, so the finger keeps it");

  pointer(window, el, "pointermove", 1, at + 100, 300);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - (moved + 100)) < 1e-6,
    `and its anchor followed the change, to ${grid.boundaryPos("x", 1)} not ${moved + 100}`,
  );
  pointer(window, el, "pointerup", 1, at + 100, 300);
  view.destroy();
});

test("a press takes no hold on a divider a change the host has not drawn moved", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  assert.ok(grid.insertAt("x", 0, { id: "rail", size: 190 }), "the rail went in");

  // No render, so the divider is still drawn where its boundary was, and the
  // number it carries names the rail's own boundary now.
  const drawn = parseFloat(el.style.left) + parseFloat(el.style.width) / 2;
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - drawn) > Math.max(grid.gap, grid.grabSize),
    "the boundary that number names is further off than the divider is grabbed at",
  );
  pointer(window, el, "pointerdown", 1, drawn, 300);
  assert.equal(el.dataset.dragging, undefined, "the press takes no hold");
  const was = grid.rect("rail").w;
  pointer(window, el, "pointermove", 1, drawn + 40, 300);
  assert.equal(grid.rect("rail").w, was, "and the move that follows drives nothing");
  view.destroy();
});

test("a mouse press takes no hold on a divider a change the host has not drawn moved", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const doc = window.document;
  assert.ok(grid.insertAt("x", 0, { id: "rail", size: 190 }), "the rail went in");

  // No render, so the divider is still drawn where its boundary was, and the
  // number it carries names the rail's own boundary now.
  const drawn = parseFloat(el.style.left) + parseFloat(el.style.width) / 2;
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - drawn) > Math.max(grid.gap, grid.grabSize),
    "the boundary that number names is further off than the divider is grabbed at",
  );
  el.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: drawn, clientY: 300, bubbles: true, button: 0, buttons: 1,
  }));
  assert.equal(el.dataset.dragging, undefined, "the press takes no hold");
  const was = grid.rect("rail").w;
  doc.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: drawn + 40, clientY: 300, bubbles: true, buttons: 1,
  }));
  assert.equal(grid.rect("rail").w, was, "and the move that follows drives nothing");
  view.destroy();
});

test("a key drives nothing on a divider a change the host has not drawn moved", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const key = (name) =>
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  assert.ok(grid.insertAt("x", 0, { id: "rail", size: 190 }), "the rail went in");

  const was = grid.rect("rail").w;
  key("ArrowRight");
  assert.equal(grid.rect("rail").w, was, "the arrow resizes no card");
  key("Enter");
  assert.equal(grid.rect("rail").w, was, "and neither does Enter");
  view.destroy();
});

test("a press while the host holds the draw takes hold of the boundary the view moved", () => {
  let hold = false;
  let pending = null;
  const { window, host, grid, view } = mount({
    commit: (_rects, draw) => {
      if (hold) pending = draw;
      else draw();
    },
  });
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const at = grid.boundaryPos("x", 1);

  // The view moves the boundary and the host has not drawn it, so the element is
  // behind by the view's own change. That is not a change the host made, and the
  // gesture was carried through it.
  hold = true;
  pointer(window, el, "pointerdown", 1, at, 300);
  pointer(window, el, "pointermove", 1, at + 150, 300);
  pointer(window, el, "pointerup", 1, at + 150, 300);
  const moved = grid.boundaryPos("x", 1);
  assert.equal(moved, at + 150, "the drag moved it, and nothing is drawn yet");

  pointer(window, el, "pointerdown", 1, at + 150, 300);
  assert.equal(el.dataset.dragging, "true", "the next press takes hold");
  pointer(window, el, "pointermove", 1, at + 200, 300);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - (moved + 50)) < 1e-6,
    `and drives its own boundary, to ${grid.boundaryPos("x", 1)} not ${moved + 50}`,
  );
  pointer(window, el, "pointerup", 1, at + 200, 300);
  hold = false;
  pending();
  view.destroy();
});

test("a press takes hold across a change smaller than the width its divider is grabbed at", () => {
  const { window, host, grid, view } = mount();
  // The reach is the width the divider is grabbed at, which is the larger of the
  // gap and grabSize. 16 is inside that and outside the smaller of the two.
  assert.equal(grid.gap, 24);
  assert.equal(grid.grabSize, 11);
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const drawn = parseFloat(el.style.left) + parseFloat(el.style.width) / 2;

  // The host moves the boundary itself and does not render, so the divider is
  // still drawn 16 away from where its boundary now stands.
  grid.moveBoundary("x", 1, grid.boundaryPos("x", 1) + 16, false);
  const moved = grid.boundaryPos("x", 1);
  assert.ok(Math.abs(moved - (drawn + 16)) < 1e-6, `the host moved the boundary 16, to ${moved}`);

  pointer(window, el, "pointerdown", 1, drawn, 300);
  assert.equal(el.dataset.dragging, "true", "16 is inside the grab width, so the press takes hold");
  pointer(window, el, "pointermove", 1, drawn + 100, 300);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - (moved + 100)) < 1e-6,
    `and drives it from where the host left it, to ${grid.boundaryPos("x", 1)} not ${moved + 100}`,
  );
  pointer(window, el, "pointerup", 1, drawn + 100, 300);
  view.destroy();
});

test("a render the host names a reason of its own for settles the gesture too", () => {
  const { window, host, grid, view } = mount();
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const held = grid.boundaryPos("x", 1);
  pointer(window, el, "pointerdown", 1, held, 300);
  assert.equal(el.dataset.dragging, "true", "the finger has the divider");

  // The host puts in a card that reaches across the plane and asks for the draw
  // under a reason of its own. The reason is the host's to name and every one of
  // them is a reason it may name, so what settles the gesture is that the host
  // asked for the draw, not which of the five words it used.
  assert.ok(grid.insertAt("x", 0, { id: "rail", size: 190 }), "the rail went in");
  view.render("resize");
  assert.equal(el.dataset.dragging, undefined, "nothing holds the divider any more");

  const was = grid.rect("rail").w;
  pointer(window, el, "pointermove", 1, held + 100, 300);
  assert.equal(grid.rect("rail").w, was, "and the next move drives no boundary at all");
  view.destroy();
});

test("a press takes no hold across a change the host is holding its own draw of", () => {
  let pending = null;
  const { window, host, grid, view } = mount({
    commit: (_rects, draw) => {
      pending = draw;
    },
  });
  pending();                              // the render the mount made
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const drawn = parseFloat(el.style.left) + parseFloat(el.style.width) / 2;

  // The host puts in a card that reaches across the plane and renders, and holds
  // that draw. The element is behind by a change the host made, not by one the
  // view made and carried the gestures through, so the divider is not the
  // boundary the number it carries names.
  assert.ok(grid.insertAt("x", 0, { id: "rail", size: 190 }), "the rail went in");
  view.render();
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - drawn) > Math.max(grid.gap, grid.grabSize),
    "the boundary that number names is further off than the divider is grabbed at",
  );

  pointer(window, el, "pointerdown", 1, drawn, 300);
  assert.equal(el.dataset.dragging, undefined, "the press takes no hold");
  const was = grid.rect("rail").w;
  pointer(window, el, "pointermove", 1, drawn + 40, 300);
  assert.equal(grid.rect("rail").w, was, "and the move that follows drives nothing");
  pending();
  view.destroy();
});

test("a press on another divider leaves the drag it dropped disarmed on its own divider", () => {
  const { window, host, grid, view } = mount();
  grid.split("card", "y");
  view.render();
  const across = host.querySelector('.sp-divider[data-axis="x"]');
  const down = host.querySelector('.sp-divider[data-axis="y"]');
  assert.ok(across && down, "the plane has a divider on each axis");

  const at = grid.boundaryPos("x", 1);
  pointer(window, across, "pointerdown", 1, at, 150);
  pointer(window, across, "pointermove", 1, at + 200, 150);
  const moved = grid.boundaryPos("x", 1);
  assert.ok(Math.abs(moved - (at + 200)) < 1e-6, `the drag moved the boundary, to ${moved}`);

  // The release of that press is never delivered, and the next press lands on
  // the other divider with the same pointer, so that press is the one dropping
  // the drag. The press it disarms is the one on the divider the drag was on.
  pointer(window, down, "pointerdown", 1, 300, grid.boundaryPos("y", 1));
  pointer(window, down, "pointerup", 1, 300, grid.boundaryPos("y", 1));

  pointer(window, across, "pointerdown", 1, moved, 150);
  assert.equal(grid.boundaryPos("x", 1), moved, "the next press takes hold, it does not centre");
  assert.equal(across.dataset.dragging, "true", "and the divider is held again");
  pointer(window, across, "pointerup", 1, moved, 150);
  view.destroy();
});

test("a mouse press on another divider leaves the drag it dropped disarmed on its own divider", () => {
  const { window, host, grid, view } = mount();
  grid.split("card", "y");
  view.render();
  const doc = window.document;
  const across = host.querySelector('.sp-divider[data-axis="x"]');
  const down = host.querySelector('.sp-divider[data-axis="y"]');
  const press = (target, type, x, y, buttons) =>
    target.dispatchEvent(
      new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0, buttons }),
    );

  const at = grid.boundaryPos("x", 1);
  press(across, "mousedown", at, 150, 1);
  press(doc, "mousemove", at + 200, 150, 1);
  const moved = grid.boundaryPos("x", 1);
  assert.ok(Math.abs(moved - (at + 200)) < 1e-6, `the drag moved the boundary, to ${moved}`);

  // As on the pointer path: the release is never delivered, the next press lands
  // on the other divider, and the press it disarms is the one on the divider the
  // drag was on.
  press(down, "mousedown", 300, grid.boundaryPos("y", 1), 1);
  press(down, "mouseup", 300, grid.boundaryPos("y", 1), 0);

  press(across, "mousedown", moved, 150, 1);
  assert.equal(grid.boundaryPos("x", 1), moved, "the next press takes hold, it does not centre");
  assert.equal(across.dataset.dragging, "true", "and the divider is held again");
  press(across, "mouseup", moved, 150, 0);
  view.destroy();
});

test("a press takes no hold across a host change made while a draw of the view's own is still out", () => {
  let pending = null;
  const { window, host, grid, view } = mount({
    commit: (_rects, draw) => {
      pending = draw;
    },
  });
  pending();                              // the render the mount made
  const el = host.querySelector('.sp-divider[data-axis="x"]');
  const at = grid.boundaryPos("x", 1);

  // The view moves the boundary and the host holds that draw, so the elements
  // are behind by a change of the view's own.
  pointer(window, el, "pointerdown", 1, at, 300);
  pointer(window, el, "pointermove", 1, at + 120, 300);
  pointer(window, el, "pointerup", 1, at + 120, 300);

  // The host now makes a change of its own and renders. It holds that draw too,
  // so the elements are behind by the host's change as well, and the gesture was
  // carried through only the view's.
  assert.ok(grid.insertAt("x", 0, { id: "rail", size: 190 }), "the rail went in");
  view.render();

  pointer(window, el, "pointerdown", 1, at + 120, 300);
  assert.equal(el.dataset.dragging, undefined, "the press takes no hold");
  const was = grid.rect("rail").w;
  pointer(window, el, "pointermove", 1, at + 160, 300);
  assert.equal(grid.rect("rail").w, was, "and the move that follows drives nothing");
  pending();
  view.destroy();
});

/**
 * A plane with a line no card reads below two the cards do read, and a host that
 * holds every draw.
 *
 * A drag that passes the unread line drops it, and every line above it is
 * renumbered. The number a divider element carries is written by the paint, so
 * until the host performs the draw every element still carries the number it had.
 */
function renumbering() {
  const dom = new JSDOM("<!doctype html><div id=host></div>", { pretendToBeVisual: true });
  const { window } = dom;
  for (const name of ["PointerEvent", "Event", "Node", "HTMLElement"]) {
    globalThis[name] = window[name];
  }
  globalThis.document = window.document;
  delete globalThis.ResizeObserver;

  const host = window.document.getElementById("host");
  Object.defineProperty(host, "clientWidth", { value: 1200, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 1000, configurable: true });

  const grid = new Soksak(undefined, { width: 1200, height: 1000, gap: 24 });
  let pending = null;
  const view = new SoksakView(host, grid, {
    createCard: () => window.document.createElement("div"),
    commit: (_rects, draw) => {
      pending = draw;
    },
  });
  grid.replace({
    xs: [0, 1],
    ys: [0, 0.2, 0.4, 0.6, 0.8, 1],
    cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 2 },
      { id: "b", c0: 0, c1: 1, r0: 2, r1: 3 },
      { id: "c", c0: 0, c1: 1, r0: 3, r1: 4 },
      { id: "d", c0: 0, c1: 1, r0: 4, r1: 5 },
    ],
    paidBy: {},
  });
  view.render();
  pending();
  assert.equal(grid.isVirtual("y", 1), true, "line 1 is read by no card");

  const held = host.querySelector('.sp-divider[data-axis="y"][data-line="2"]');
  const other = host.querySelector('.sp-divider[data-axis="y"][data-line="3"]');
  assert.ok(held && other, "both boundaries have a grab area");

  // The drag passes the line no card reads. The host holds the draw, so no
  // element is renumbered and none is moved.
  pointer(window, held, "pointerdown", 1, 600, grid.boundaryPos("y", 2));
  pointer(window, held, "pointermove", 1, 600, 170);
  assert.equal(grid.lines("y").length, 5, "the line the move passed is gone");
  return { window, host, grid, view, held, other, draw: () => pending() };
}

test("a press takes no hold on a divider a change the host is holding the draw of renumbered", () => {
  const { window, grid, view, other, draw } = renumbering();
  const drawn = parseFloat(other.style.top) + parseFloat(other.style.height) / 2;
  assert.equal(other.dataset.line, "3", "the element still carries the number the paint gave it");
  assert.ok(
    Math.abs(grid.boundaryPos("y", 3) - drawn) > Math.max(grid.gap, grid.grabSize),
    "and line 3 now names a boundary further off than the divider is grabbed at",
  );

  const was = grid.lines("y").slice();
  pointer(window, other, "pointerdown", 2, 600, drawn);
  assert.equal(other.dataset.dragging, undefined, "the press takes no hold");
  pointer(window, other, "pointermove", 2, 600, drawn + 60);
  assert.deepEqual(grid.lines("y"), was, "and the move that follows drives nothing");
  draw();
  view.destroy();
});

test("a second finger drives the boundary the gesture holds after a change the host is holding the draw of renumbered", () => {
  const { window, grid, view, held, draw } = renumbering();
  const drawn = parseFloat(held.style.top) + parseFloat(held.style.height) / 2;
  assert.equal(held.dataset.line, "2", "the element still carries the number the paint gave it");
  const own = grid.boundaryPos("y", 1);
  assert.ok(Math.abs(own - 170) < 1e-6, `the gesture carried its boundary to line 1, at ${own}`);

  // The second finger lands on the divider the first one holds. The gesture on
  // it was carried through the change, so the boundary it addresses is that
  // gesture's, not the one the number the element carries now names.
  pointer(window, held, "pointerdown", 2, 600, drawn);
  assert.equal(held.dataset.dragging, "true", "the press takes hold");
  pointer(window, held, "pointermove", 2, 600, drawn + 60);
  assert.ok(
    Math.abs(grid.boundaryPos("y", 1) - (own + 60)) < 1e-6,
    `it drives the gesture's own boundary, to ${grid.boundaryPos("y", 1)} not ${own + 60}`,
  );
  assert.ok(
    Math.abs(grid.boundaryPos("y", 2) - 600) < 1e-6,
    `and leaves the one the old number names at ${grid.boundaryPos("y", 2)}`,
  );
  draw();
  view.destroy();
});

/**
 * A finger holding a y boundary the host has since moved out from under it.
 *
 * The host makes the change and does not render, so nothing has told the
 * gesture. The x boundary is off centre, so a centring on it moves something.
 */
function stranded() {
  const { window, host, grid, view } = mount();
  grid.split("card", "y");
  grid.moveBoundary("x", 1, grid.boundaryPos("x", 1) + 150);
  view.render();

  const held = host.querySelector('.sp-divider[data-axis="y"]');
  const other = host.querySelector('.sp-divider[data-axis="x"]');
  const at = grid.boundaryPos("y", 1);
  pointer(window, held, "pointerdown", 1, 200, at);
  pointer(window, held, "pointermove", 1, 200, at + 10);

  grid.moveBoundary("y", 1, at + 160);
  const moved = grid.boundaryPos("y", 1);
  assert.ok(
    moved - (at + 10) > Math.max(grid.gap, grid.grabSize),
    `the host moved it ${moved - (at + 10)} away, further than it is grabbed at`,
  );
  return { window, grid, view, held, other, at, moved };
}

test("one mouse move is one change, however many dividers the plane has", () => {
  // Every divider listens on the divider's document, so a move is delivered to
  // all of them. Only the one holding the drag drives it: a host that places its
  // own views in `commit` does that work once per move, not once per divider.
  const commits = [];
  const changes = [];
  const { window, host, grid, view } = mount({
    commit: (rects, draw) => { commits.push(rects.size); draw(); },
    onChange: (reason) => changes.push(reason),
  });
  grid.split("card", "y");
  grid.split("card-1", "y");
  view.render();
  assert.ok(host.querySelectorAll('[role="separator"]').length > 1, "more than one divider listens");

  const divider = host.querySelector('.sp-divider[data-axis="x"]');
  const at = grid.boundaryPos("x", 1);
  commits.length = 0;
  changes.length = 0;
  divider.dispatchEvent(new window.MouseEvent("mousedown", {
    clientX: at, clientY: 400, bubbles: true, button: 0, buttons: 1,
  }));
  window.document.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: at + 60, clientY: 400, bubbles: true, buttons: 1,
  }));

  assert.equal(commits.length, 1, `one move, ${commits.length} commits`);
  assert.deepEqual(changes, ["drag"], "and one change");
  view.destroy();
});

test("a key the view does not handle reaches the page", () => {
  // Arrows move the boundary and Enter and Space centre it. Everything else is
  // the page's: swallowing Tab takes focus away from the person who pressed it.
  const changes = [];
  const { window, host, grid, view } = mount({ onChange: (reason) => changes.push(reason) });
  const divider = host.querySelector('[role="separator"]');
  const before = grid.boundaryPos("x", 1);
  changes.length = 0;

  for (const key of ["Tab", "Home", "End", "Escape", "a"]) {
    const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    divider.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, `${key} was swallowed`);
  }
  assert.deepEqual(changes, [], "and none of them was reported as a change");
  assert.equal(grid.boundaryPos("x", 1), before, "the boundary did not move");

  // The keys it does handle still work.
  divider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.ok(grid.boundaryPos("x", 1) > before, "an arrow still moves it");
  view.destroy();
});

test("a release delivered to another divider does not end the drag this one holds", () => {
  // The platform gives up on a pointer by sending pointercancel to whatever is
  // under it, which is not always the element the drag started on. Only the
  // divider the pointer actually holds ends.
  const changes = [];
  const { window, host, grid, view } = mount({ onChange: (reason) => changes.push(reason) });
  grid.split("card", "y");
  view.render();
  const held = host.querySelector('.sp-divider[data-axis="x"]');
  const other = host.querySelector('.sp-divider[data-axis="y"]');
  assert.ok(held && other && held !== other, "two dividers to tell apart");

  const at = grid.boundaryPos("x", 1);
  pointer(window, held, "pointerdown", 1, at, 400);
  pointer(window, held, "pointermove", 1, at + 40, 400);
  assert.equal(held.dataset.dragging, "true", "the first divider is held");
  changes.length = 0;

  pointer(window, other, "pointercancel", 1, at + 40, 400);
  assert.equal(held.dataset.dragging, "true", "and a cancel elsewhere does not let it go");
  assert.deepEqual(changes, [], "nor report a change");

  pointer(window, held, "pointermove", 1, at + 90, 400);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - (at + 90)) < 1e-6,
    `the finger still drives its boundary, to ${grid.boundaryPos("x", 1)}`,
  );
  view.destroy();
});
