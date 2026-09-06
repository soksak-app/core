/**
 * One deliberate defect per promise the README makes.
 *
 * A mutation run flips operators and finds what no test is watching. This is
 * the other direction: each entry removes a behaviour the library states, and
 * the suite must fail. A break that survives names a promise nothing holds the
 * code to — and unlike a mutant, there is no arguing it is equivalent, because
 * the behaviour is gone.
 *
 * `find` must appear in the built file exactly as written. When a break stops
 * applying, the code moved: read it and either follow the code or delete the
 * entry, but do not leave it silently unapplied.
 */
export const BREAKS = [
  {
    id: "state",
    what: "toJSON leaves the payload behind",
    file: "dist/soksak.js",
    find: "cards: this.list.map((c) => ({ ...c })),",
    to: "cards: this.list.map(({ data, ...c }) => ({ ...c })),",
  },
  {
    id: "frozen",
    what: "cards hands back the grid's own objects",
    file: "dist/soksak.js",
    find: "return this.list.map((c) => Object.freeze({ ...c }));",
    to: "return this.list;",
  },
  {
    id: "lines",
    what: "lines hands back the live array",
    file: "dist/soksak.js",
    find: "return [...(axis === 'x' ? this.xs : this.ys)];",
    to: "return axis === 'x' ? this.xs : this.ys;",
  },
  {
    id: "slicing",
    what: "isSlicing returns true for anything",
    file: "dist/slicing.js",
    find: "export function isSlicing(list, memo = new Map()) {",
    to: "export function isSlicing(list, memo = new Map()) {\n    return true;",
  },
  {
    id: "boundary",
    what: "hasBoundary returns true for any index",
    file: "dist/soksak.js",
    find: "return Number.isInteger(line) && line >= 1 && line <= this.arr(axis).length - 2;",
    to: "return true;",
  },
  {
    id: "insert-size",
    what: "insertAt takes a size the plane cannot hold",
    file: "dist/soksak.js",
    find: "|| init.size < 0 || init.size >= plane)",
    to: "|| init.size < 0)",
  },
  {
    id: "one-slot",
    what: "setSize writes onto a card spanning two slots",
    file: "dist/soksak.js",
    find: "if (px !== null && (!Number.isFinite(px) || px < 0 || spanOf(card, axis) !== 1))",
    to: "if (px !== null && (!Number.isFinite(px) || px < 0))",
  },
  {
    id: "gap-guard",
    what: "the gap setter takes anything",
    file: "dist/soksak.js",
    find: "set gap(px) {\n        if (!Number.isFinite(px) || px < 0)\n            return;",
    to: "set gap(px) {",
  },
  {
    id: "border",
    what: "merging drops the plane's border instead of the interior line",
    file: "dist/soksak.js",
    find: "const [keep, drop] = border(line) ? [line, found] : [found, line];",
    to: "const [keep, drop] = [found, line];",
  },
  {
    id: "spanning",
    what: "mergeCoincident folds a pair a card stands between",
    file: "dist/soksak.js",
    find: "if (this.list.some((c) => at(c, lo) === at(c, hi)))\n            return false;",
    to: ";",
  },
  {
    id: "corridor",
    what: "a starved slot eats the corridor instead of stopping at it",
    file: "dist/geometry.js",
    find: "size[starved] = corridor[starved];",
    to: "size[starved] = 0;",
  },
  {
    id: "place",
    what: "the view draws every card in the corner with no size",
    file: "dist/dom.js",
    find: "function place(el, rect) {",
    to: "function place(el, rect) {\n    rect = { x: 0, y: 0, w: 0, h: 0 };",
  },
  {
    id: "drag-way",
    what: "a drag runs the wrong way",
    file: "dist/dom.js",
    find: "this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from))",
    to: "this.grid.moveBoundary(drag.axis, drag.line, drag.base - (now - drag.from))",
  },
  {
    id: "sweep",
    what: "a swept divider keeps its drag and takes everyone else's",
    file: "dist/dom.js",
    find: "if (drag.on === el)",
    to: "if (drag.on !== el)",
  },
  {
    id: "hidden-host",
    what: "a host that reports no size is measured as nothing",
    file: "dist/dom.js",
    find: "if (host.clientWidth <= 0 || host.clientHeight <= 0)",
    to: "if (host.clientWidth < 0 || host.clientHeight < 0)",
  },
  {
    id: "radius",
    what: "outline turns every corner the same way",
    file: "dist/outline.js",
    find: "${turn > 0 ? 1 : 0} ",
    to: "${1} ",
  },
  {
    id: "bleed",
    what: "a rule bleeds past the end a card stops it at",
    file: "dist/dom.js",
    find: "const head = rule.x <= EDGE ? bleed : 0;",
    to: "const head = bleed;",
  },
  {
    id: "snap-off",
    what: "a drag snaps although snapping is off or the caller refused it",
    file: "dist/soksak.js",
    find: "if (allowSnap && this.snap !== 'off') {",
    to: "if (true) {",
  },
  {
    id: "span-size",
    what: "a card that comes to span two slots keeps the px size it declared",
    file: "dist/soksak.js",
    find: "if (card.width !== undefined && card.c1 - card.c0 !== 1)",
    to: "if (false)",
  },
  {
    id: "made-up-axis",
    what: "lines answers for an axis that is not one",
    file: "dist/soksak.js",
    find: "        if (this.noAxis(axis))\n            return [];",
    to: "        if (false)\n            return [];",
  },
  {
    id: "centre-reason",
    what: "a centring is reported as a drag",
    file: "dist/dom.js",
    find: "this.draw('center');",
    to: "this.draw('drag');",
  },
  {
    id: "watch-host",
    what: "the view watches the host although it was told not to",
    file: "dist/dom.js",
    find: "if (options.observeResize !== false && typeof ResizeObserver !== 'undefined')",
    to: "if (typeof ResizeObserver !== 'undefined')",
  },
  {
    id: "grip",
    what: "the sheet declares the tokens and draws nothing with them",
    file: "dist/theme.js",
    find: ".${prefix}-divider::after {",
    to: ".${prefix}-nothing::after {",
  },
  {
    id: "in-order",
    what: "split writes a line before the one it follows",
    file: "dist/soksak.js",
    find: "const value = Math.min(Math.max(cut.value, a[line - 1]), a[line]);",
    to: "const value = cut.value;",
  },
  {
    id: "starved",
    what: "a slot a card spans past is charged the corridor it holds",
    file: "dist/geometry.js",
    find: "if (first >= 0 && fixed + span * each < need - 1e-9) {",
    to: "if (first >= 0 && (a[first + 1] - a[first]) * each < corridor[first] - 1e-9) {",
  },
  {
    id: "seam",
    what: "two edges a rounding apart leave a seam between two cards",
    file: "dist/outline.js",
    find: "if (!out.length || v - out[out.length - 1] > 0.01 + 1e-9)",
    to: "if (true)",
  },
  {
    id: "range-line",
    what: "boundaryRange answers for a line that carries no boundary",
    file: "dist/soksak.js",
    find: "if (!this.hasBoundary(axis, line))\n            return [0, 0];",
    to: "if (false)\n            return [0, 0];",
  },
  {
    id: "scaled-size",
    what: "a drag declares the size the plane drew, not the size that draws it",
    file: "dist/geometry.js",
    find: "export function declaredFor(plane, axis, slot, drawn) {",
    to: "export function declaredFor(plane, axis, slot, drawn) {\n    return drawn;",
  },
  {
    id: "centre-scaled",
    what: "centring moves once and does not check where the boundary landed",
    file: "dist/soksak.js",
    find: "for (let pass = 0; pass < 8; pass++) {",
    to: "for (let pass = 0; pass < 1; pass++) {",
  },
  {
    id: "commit-rects",
    what: "commit reports the grid's rects rather than the ones the render writes",
    file: "dist/dom.js",
    find: "on.set(id, onGrid(rect, step));",
    to: "on.set(id, rect);",
  },
  {
    id: "grab",
    what: "the grab area ignores grabSize, so a zero gap cannot be grabbed",
    file: "dist/geometry.js",
    find: "const hit = Math.max(plane.gap, grabSize);",
    to: "const hit = plane.gap;",
  },
];
