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
    find: "if ((a[i + 1] - a[i]) * each < corridor[i] - 1e-9) {",
    to: "if (false) {",
  },
  {
    id: "place",
    what: "the view draws every card in the corner with no size",
    file: "dist/dom.js",
    find: "function place(el, rect, step) {",
    to: "function place(el, rect, step) {\n    rect = { x: 0, y: 0, w: 0, h: 0 };",
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
    id: "grab",
    what: "the grab area ignores grabSize, so a zero gap cannot be grabbed",
    file: "dist/geometry.js",
    find: "const hit = Math.max(plane.gap, grabSize);",
    to: "const hit = plane.gap;",
  },
];
