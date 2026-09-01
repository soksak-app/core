# soksak

Pane layout over shared grid lines. Headless core, optional DOM binding, no dependencies.

Panes are split, closed, and resized by dragging the boundaries between them. What makes this
one different is that a boundary is **one number shared by both sides**, so it cannot drift, and
that the operations are constrained to keep three properties true no matter what the user does:

- **Panes tile the plane exactly.** No overlap, no gap left over, and the corridor between any
  two neighbours is always the configured `gap`.
- **No pane ever falls below `minSize`.** Splitting and dragging both respect it, and the split
  button reports it before you offer it.
- **Every pane stays closable.** Closing one is never a dead end.

## Install

```sh
pnpm add soksak
```

## The model

Two arrays of numbers own every coordinate:

```
xs   vertical grid lines,   normalised 0..1
ys   horizontal grid lines, normalised 0..1
```

A pane is a span of indices into them — `{ c0, c1, r0, r1 }`. Two panes that meet read the same
index, so their shared boundary is a single number. Moving a line moves every pane that
references it; a pane that spans *across* the line is untouched. For that pane the line is
**virtual** — invisible as a boundary, but still there, and a later split snaps to it. That is how
a split derived from one pane lines up with a split derived from another.

There is no tree and no grouping.

## Quick start — headless

```js
import { Soksak } from "soksak";

const grid = new Soksak(undefined, { width: 1200, height: 800 });

const right = grid.split("pane", "x");   // cut left/right; returns the new pane id
grid.split(right, "y");                  // cut that one top/bottom

// a host payload rides on the pane; give the new one its own
grid.split(right, "x", { id: "editor", data: { surface: openEditor() } });

for (const [id, rect] of grid.rects()) {
  console.log(id, rect);                   // { x, y, w, h } in px
}

grid.moveLine("x", 1, 0.4);              // drag the shared boundary
grid.centerLine("x", 1);                 // put it where both panes come out equal
grid.close(right);                       // neighbours grow into the space
```

Start from a shape instead of one pane by passing state:

```js
const grid = new Soksak(
  {
    xs: [0, 0.28, 1],
    ys: [0, 0.52, 1],
    panes: [
      { id: "sidebar", c0: 0, c1: 1, r0: 0, r1: 2, fixed: true },
      { id: "terminal", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "browser", c0: 1, c1: 2, r0: 1, r1: 2 },
    ],
  },
  { width: 1200, height: 800 },
);
```

A `fixed` pane is never split, never closed, and never used to fill a closed neighbour — which is
what keeps a sidebar from spreading over the plane.

`grid.toJSON()` and `Soksak.from(state, options)` round-trip the whole arrangement.

## Quick start — DOM

`SoksakView` owns position, lifecycle and pointer input. It does **not** own markup: pane
elements come from your `createPane`, and the elements it must create itself carry only a class
name and data attributes, with no styling. Everything visible is your CSS.

```js
import { Soksak, SoksakView } from "soksak";

const host = document.querySelector("#stage");   // needs position: relative
const grid = new Soksak();

const view = new SoksakView(host, grid, {
  createPane(pane) {
    const el = document.createElement("article");
    el.className = "card";
    el.append(mySurfaceFor(pane.id));            // survives splits, closes and drags
    return el;
  },
  onChange() {
    drawOutline();                                // your own outline, see below
  },
});
view.render();
```

Pane elements are created once and reused, so a live surface inside one — a terminal, a webview,
a canvas — is never torn down by a change to the arrangement. Splitting keeps the original pane object and
its near half; the new pane takes the far half.

The view creates two kinds of element:

| Element | Class | Data attributes |
| --- | --- | --- |
| grab area | `sp-divider` | `data-axis="x\|y"`, `data-line`, `data-dragging` while held |
| boundary line | `sp-rule` | `data-axis="x\|y"`, `data-virtual="true\|false"` |

Set `classPrefix` to rename them. Minimum CSS to make them usable:

```css
#stage { position: relative; }
.card { box-sizing: border-box; }          /* or the border adds to the rect */
.sp-divider[data-axis="x"] { cursor: col-resize; }
.sp-divider[data-axis="y"] { cursor: row-resize; }
.sp-rule[data-virtual="false"] { background: #6b74ff; }
.sp-rule[data-virtual="true"]  { background: #6b74ff33; }
```

The view sets `width` and `height` on your pane element, so give it
`box-sizing: border-box` if it has a border or padding — otherwise the element
ends up larger than the rect the grid computed and the corridors close up.

For the same reason, make sure nothing inside the pane can inflate it past the
width the view set. A flex or grid child defaults to `min-width: auto`, which
resolves to its min-content, and a column then stretches to fit — the element
reports a rect wider than the size it was given. `overflow: hidden` hides that
visually but does not shrink the rect. If anything positions itself from that
rect and is not clipped by the pane — an OS-level view composited over the page,
for instance — it lands outside the pane. Give the pane's children `min-width: 0`.

```css
.card > * { min-width: 0; }
```

Dragging a divider moves the line. Double-clicking it (or Enter/Space when focused) centres it so
the two panes beside it come out the same size. Arrow keys nudge it.

## Clean lines and a band standing on one

A line is **clean** when it is a boundary over the whole plane — no pane spans
across it. That is a fact about the spans, not a comparison of coordinates, so
there is no tolerance to tune and no drift to repair. Dragging a line can never
make it clean or unclean; only splitting and closing can.

```js
grid.cleanLines("x");          // [0, 1, 3] - line 2 is blocked
grid.isCleanLine("x", 2);      // false
grid.panesCrossing("x", 2);    // the panes standing in the way
grid.nearestCleanLine("x", v); // the closest one to a normalised position
```

A **station** is a fixed-width band standing on a clean line, taking room from
the panes on either side — a sidebar that lives between panes rather than at the
window edge. It may only stand on a clean line, because a pane that crossed it
would be cut in two.

```js
grid.setStation("x", 1, 200);  // false if that line is blocked
grid.stationRect();            // { x, y, w, h } - inset by half a corridor, like a pane
grid.clearStation();
```

The band keeps the corridor rule: one full `gap` between it and the pane on each
side, so its drawn width is `size - gap`. Panes past it are pushed along by its
width and keep their own proportions among themselves.

## The outline

`outline()` draws a single rounded shape around any set of panes — a sidebar bound to whichever
view is focused, say. Panes separated by a corridor do not touch, so grow them first: at
`pad = gap / 2` the grown rects meet on the corridor centre line and the union closes into one
loop. Every right angle becomes an arc, including the reflex corners of an L.

```js
import { outline } from "soksak";

const rects = ["sidebar", focused].map((id) => grid.rect(id));
const shape = outline(rects, { pad: grid.gap / 2, radius: 14 + grid.gap / 2 });

path.setAttribute("d", shape.path);   // works for both fill (evenodd) and stroke
shape.loops.length;                   // 1 when the panes are adjacent, 2 when they are apart
```

`contains(shape.loops, x, y)` tests a point, which is how you check that a pane you left out
really stayed outside.

## Why every pane stays closable

Splitting only ever replaces one pane with two, so the layout is always a **slicing** (guillotine)
floorplan. A pinwheel — four panes each overhanging the one in the middle, so that no side can
take its place — is the canonical *non*-slicing arrangement, and splitting cannot reach it.

Closing has to preserve that. It lets a whole row of neighbours grow together, not just a single
matching one, and it only accepts a side that leaves the layout slicing. In a slicing floorplan
such a side always exists, so `canClose` is true for every pane except the last one.

`grid.isSlicing()` checks the property directly if you want to assert it in your own tests.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `gap` | `24` | Corridor between panes, px. Half of it is the outer margin, the outline offset, and how far a boundary line runs past a pane. |
| `minSize` | `96` | Smallest pane edge, px. |
| `grabSize` | `11` | Smallest grab area, px. Independent of `gap`, so `gap: 0` is still draggable. |
| `snap` | `"merge"` | `"merge"`: a dragged line snaps onto a neighbour it nearly meets and the two become one line. `"off"`: neither. |
| `snapDistance` | `7` | How close it must come, px. |
| `fillOrder` | `"v"` | Which axis a close tries first: `"v"` fills from above/below, `"h"` from the sides. |
| `width`, `height` | `0` | Plane size. `resize(w, h)` updates it; the view does this for you. |

## API

`Soksak`

| | |
| --- | --- |
| `panes`, `pane(id)`, `rect(id)`, `rects()`, `rectOf(pane)` | read the arrangement |
| `resize(w, h)`, `width`, `height` | plane size |
| `canSplit(id, axis)`, `split(id, axis, {id?, data?})` | cut one pane in two |
| `canClose(id)`, `close(id)`, `fill(id)` | remove a pane; `fill` reports which neighbours would take the space |
| `dividers()`, `rules()` | grab areas, and boundaries to draw |
| `moveLine(axis, line, value)`, `lineRange(axis, line)`, `centerLine(axis, line)` | drag a boundary |
| `mergeCoincident(axis, line)` | fold a line onto the neighbour it now coincides with |
| `cleanLines(axis)`, `isCleanLine(axis, line)`, `nearestCleanLine(axis, v)`, `panesCrossing(axis, line)` | lines nothing spans across |
| `station`, `setStation(axis, line, size)`, `stationRect()`, `clearStation()` | a band standing on a clean line |
| `tidy()`, `virtualCount()`, `isVirtual(axis, line)`, `crossings(pane)` | virtual lines |
| `isSlicing()`, `lines(axis)`, `toJSON()`, `Soksak.from(state)` | inspection and state |

`SoksakView` — `render(reason?)`, `element(id)`, `destroy()`.

`outline(rects, options)`, `unionLoops(rects)`, `roundedPath(loop, radius, innerRadius)`,
`contains(loops, x, y)`.

## License

MIT
