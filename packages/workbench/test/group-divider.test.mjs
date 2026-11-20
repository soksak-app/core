// The divider gestures of the plane in a space with groups (docs/spec/groups.md#minimum-size): a drag stops at the last position at
// which every content card beside its line is drawn at least minSize below the headers, and a centring that would draw a content card
// below its minimum leaves the line where it stands.
import assert from "node:assert/strict";
import test from "node:test";
import { openVerifyPlane } from "./support/verify-plane.mjs";

const page = await openVerifyPlane();
const { plane, planeEl } = page;
// The release of a divider drag runs core.boundary.move, which the core exposure of the page registers; the core exposure listens to
// the resize of the window.
globalThis.addEventListener = window.addEventListener.bind(window);
const { installCoreExposure } = await import("../core-exposure.js");
const { pageMemorySaver } = await import("./support/memory-saver.mjs");
const { registry } = await import("../exposure.js");
await installCoreExposure({ library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
  memorySaver: await pageMemorySaver() });

const content = (id) => {
  const tabs = [{ id: `tab-${id}`, plugin: "fixture-verify", title: id }];
  return { card: id, data: { tabs, activeId: tabs[0].id } };
};

/** The group card-4 of card-1 above card-2 in the left half, beside card-3 across the whole height. */
function arrange() {
  plane.adopt({
    state: { root: { cut: "x", kids: [
      { share: 0.5, node: { box: "card-4", data: { name: "그룹 1", leader: "card-1" }, inner: { cut: "y", kids: [
        { share: 0.5, node: content("card-1") }, { share: 0.5, node: content("card-2") },
      ] } } },
      { share: 0.5, node: content("card-3") },
    ] } },
    leader: "card-4", lastCard: 4, focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {},
  }, "spc-aaaaaa");
  page.redraw();
}

const divider = () => planeEl.querySelector('.sp-divider[data-axis="y"]');
const mouse = (target, type, y, buttons) =>
  target.dispatchEvent(new window.MouseEvent(type, { clientX: 10, clientY: y, button: 0, buttons, bubbles: true }));

test("a divider drag in a space with groups stops where the card below the header is drawn at its minimum", { timeout: 5000 }, async () => {
  arrange();
  const grid = plane.currentGrid();
  const from = grid.boundaryPos("y", 1);
  mouse(divider(), "mousedown", from, 1);
  mouse(document, "mousemove", from - 1000, 1);
  mouse(document, "mouseup", from - 1000, 0);
  await registry.commandsEnded();
  const drawn = plane.currentTree().rect("card-1");
  assert.ok(Math.abs(drawn.h - grid.minSize) < 0.5, `card-1 is drawn ${drawn.h} high, not its minimum ${grid.minSize}`);
  page.reset();
});

test("a centring that would draw the card below the header below its minimum leaves the line", { timeout: 5000 }, () => {
  arrange();
  const grid = plane.currentGrid();
  const tree = plane.currentTree();
  const step = tree.options.head + grid.gap;
  // The plane has room for the two cards of the group at their minimum below the header, the corridor of the line, the frame of the
  // group below card-2 and a little more, so the middle of the line draws card-1 below its minimum.
  page.size.height += 2 * grid.minSize + step + 2 * grid.gap + 8 - grid.height;
  page.redraw();
  tree.moveBoundary("y", 1, grid.minSize + step + grid.gap / 2, false);
  page.redraw();
  const stood = grid.boundaryPos("y", 1);
  assert.ok(Math.abs(tree.rect("card-1").h - grid.minSize) < 0.5 && stood > grid.height / 2, "card-1 starts at its minimum above the middle");
  for (let press = 0; press < 2; press++) {
    mouse(divider(), "mousedown", stood, 1);
    mouse(document, "mouseup", stood, 0);
  }
  assert.equal(grid.boundaryPos("y", 1), stood, "the centring leaves the line where it stands");
  assert.ok(tree.rect("card-1").h >= grid.minSize - 0.5, `card-1 is drawn ${tree.rect("card-1").h} high`);
  page.reset();
});

// The plane marks each divider element with whether it draws its grip, which the stylesheet reads (docs/spec/groups.md#drawing).
test("each divider element of the plane says whether its stretch draws the grip", { timeout: 5000 }, () => {
  arrange();
  const dividers = [...planeEl.querySelectorAll(".sp-divider")];
  assert.ok(dividers.length > 0, "the plane draws no divider");
  for (const el of dividers) {
    const length = parseFloat(el.dataset.axis === "x" ? el.style.height : el.style.width);
    assert.equal(el.dataset.grip, String(length >= 24), `the divider of length ${length} says grip ${el.dataset.grip}`);
  }
  page.reset();
});
