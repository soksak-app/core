# soksak

Pane layout over shared grid lines. Headless core, optional DOM binding, no dependencies.

## The rules

Seven of them. Everything else follows.

**R1 — A boundary is one number.**
Two arrays, `xs` and `ys`, own every coordinate. A card is a span of indices into
them, so two cards that meet read the same index. Their shared boundary is one
number and cannot drift, and no tolerance is ever consulted to decide *where a
card is* or *whether two cards meet* — those are integer facts.

Tolerance appears three times, and none of them decides that:
`snapDistance` is a gesture, saying how near a drag must come before it lands
exactly on a neighbouring line; `mergeCoincident` compares two coordinates a
snap has already made equal, which is float equality rather than a judgement;
and the outline traces a union of rectangles, where two corners at the same
place have to be recognised as one.

**R2 — Everything is a card.**
A sidebar, a rail, a terminal — one type, one rect rule, one corridor, one
radius, one outline. A role is one answer: whether the layout moves it. A card
may also carry a `width`, which is an attribute and not a second kind of card.

**R3 — A card occupies its slots, so nothing can cross it.**
A card holding a column *is* the guarantee that no other card spans across it —
nothing has to be measured to keep it true, and dragging can never break it.
Placing a card that reaches across the plane does ask whether a card spans the
boundary (`canInsertAt`), but that is counting spans, not comparing coordinates:
an integer answer, with nothing to tune and nothing to repair afterwards.

**R4 — Splitting only ever replaces one card with two.**
So the arrangement is always a slicing floorplan, a pinwheel is unreachable, and
every card stays closable.

**R5 — The corridor is half a gap on every inner edge.**
A card at the plane's border is flush there. The same for every card, whatever
its role, so nothing around one needs a special case.

**R6 — Rects are computed in one place, from the lines.**
`geometry.ts` and nothing else — card rects, boundary rules, and grab areas all
come out of it. `soksak.ts` holds the state and asks.

**R7 — A card can always leave.**
Every open card can be closed, and what is left is again an arrangement splitting
could have built — so no action becomes impossible because of an earlier one.
There are two ways out: a row of neighbours grows into the space, or, when none
can because they are all fixed, the card's own slots go and the sharing cards
take the room back.

## Install

```sh
pnpm add soksak
```

## The model

```
xs   vertical grid lines,   normalised 0..1 over the sharing slots
ys   horizontal grid lines
```

A card is `{ id, c0, c1, r0, r1 }` — which slots it occupies. Moving a line moves
every card that reads it; a card that spans *across* the line is untouched. For
that card the line is **virtual** — invisible as a boundary, still there, and a
later split snaps to it, which is how a split derived from one card lines up with
a split derived from another.

There is no tree and no grouping.

## A sidebar is a card

```js
const grid = new Soksak({
  xs: [0, 1 / 3, 1],
  ys: [0, 0.5, 1],
  cards: [
    { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, width: 180, fixed: true },
    { id: "terminal", c0: 1, c1: 2, r0: 0, r1: 1 },
    { id: "browser", c0: 1, c1: 2, r0: 1, r1: 2 },
  ],
}, { width: 1200, height: 800 });
```

`width` means the card takes 180px across instead of a share of what is left; the
rest share the remainder. `fixed` means the layout never splits, closes or moves
it. Give the same card a middle column and it is a rail standing between panes —
same object, same drawing, different slot. Only a card holding a single slot can
fix its size on that axis; one spanning several is taking a share of them.

Everything else reads the same for every card:

```js
grid.rects();               // Map<id, {x, y, w, h}>
grid.split("terminal", "x");
grid.close(id);
grid.move("rail", "browser", "right");   // a rail travels by moving
```

## Quick start — DOM

`SoksakView` owns position, lifecycle and pointer input. It does **not** own
markup: card elements come from your `createCard`, and the elements it creates
itself carry only a class name and data attributes.

```js
import { Soksak, SoksakView } from "soksak";

const host = document.querySelector("#stage");   // needs position: relative
const grid = new Soksak();

const view = new SoksakView(host, grid, {
  createCard(card) {
    const el = document.createElement("article");
    el.className = "card";
    el.append(mySurfaceFor(card.id));            // survives splits, closes and drags
    return el;
  },
  onChange() { drawOutline(); },
});
view.render();
```

Card elements are created once and reused, so a live surface inside one — a
terminal, a webview, a canvas — is never torn down by a layout change. Splitting
keeps the original card and its near half; the new card takes the far half.

| Element | Class | Data attributes |
| --- | --- | --- |
| grab area | `sp-divider` | `data-axis`, `data-line`, `data-dragging` while held |
| boundary line | `sp-rule` | `data-axis`, `data-virtual` |

```css
#stage { position: relative; }
.card { box-sizing: border-box; }
.card > * { min-width: 0; }                /* see the hazard below */
.sp-divider[data-axis="x"] { cursor: col-resize; }
.sp-divider[data-axis="y"] { cursor: row-resize; }
.sp-rule[data-virtual="false"] { background: #6b74ff; }
.sp-rule[data-virtual="true"]  { background: #6b74ff33; }
```

Dragging a divider moves the boundary. Double-clicking it (or Enter/Space when
focused) centres it so the two cards beside it come out the same size. That holds
beside a card with a fixed width too — a width is a number and a number has a
half.

**A card's child can inflate the rect the view set.** A flex or grid child
defaults to `min-width: auto`, so a column stretches to min-content and the
element reports a rect wider than the size it was given. `overflow: hidden` hides
that but does not shrink the rect, and anything positioned from it that the card
does not clip — an OS-level view composited over the page, for instance — lands
outside the card. Give the children `min-width: 0`.

## Boundaries

A drag is one gesture, and what it does is a fact about what is beside it: next
to a card holding its slot at a fixed size it changes that size, and anywhere
else it moves the line and both sides follow.

```js
grid.dividers();                       // each says `resizes` when it changes a card's size
grid.boundaryPos("x", 1);              // px
grid.boundaryRange("x", 1);            // [min, max] px, before something hits minSize
grid.moveBoundary("x", 1, 260);        // px
grid.centerBoundary("x", 1);
```

## A card that reaches across the plane

A rail stands between panes and reaches from one side of the plane to the other.
It cannot be made by splitting a card — that would give it the extent of the card
it came from, and it would be a pane like any other. It goes in at a boundary no
card spans over, and every card past it moves along.

```js
grid.standings("x");            // the boundaries such a card could stand on
grid.canInsertAt("x", 2);
grid.insertAt("x", 2, { id: "rail", size: 190 });
grid.moveTo("rail", "x", 4);    // a column leaves and a column arrives
```

Travelling that way closes nothing and splits nothing, so no other card's spans
change and no boundary on the other axis moves at all. That is the difference
between a rail moving and the layout being rearranged around it.

## Moving a card

Dragging a card somewhere else is one operation, not a close and a split the
caller sequences. The order matters: closing first gives the space back and
changes the target's geometry, so the cut is measured after that, and a close
that cannot happen leaves the whole move undone rather than half of it.

```js
grid.canMove("terminal", "browser", "right");   // asking is not doing
grid.move("terminal", "browser", "right");      // false, and unchanged, if refused
```

The card keeps its id, its payload and its fixed size, so a live surface rides
along and a sidebar arrives the width it left.

`splitToward(id, side, init)` is the same idea for a new card: `split` hands the
far half to the new one, so `left` and `top` have the two exchange the halves
they hold. What is exchanged is the *span* — a card's identity stays with the
card, because a host holding one and finding its id changed underneath has no way
to notice.

## Where a drop lands

```js
grid.zoneAt(x, y, { headerPx: 34, footerPx: 24, centreOnly: draggingId });
// → { id, zone: "centre" | "left" | "right" | "top" | "bottom" } | null
```

`centre` means the card itself — join what is already there. A side means the
drop needs a new place beside it. Chrome is never a side, so a header cannot read
as "the top", and the band is a fraction of the body, so a small card aims like a
large one.

## The outline

Cards separated by a corridor do not touch, so their plain union falls apart into
one loop each. Grow them first: at `pad = gap / 2` the grown rects meet on the
corridor centre line and the union closes into one shape. Every right angle
becomes an arc, including the reflex corners of an L.

```js
import { outline } from "soksak";

const rects = ["left", focused].map((id) => grid.rect(id));
const shape = outline(rects, { pad: grid.gap / 2, radius: 14 + grid.gap / 2 });
path.setAttribute("d", shape.path);   // works for both fill (evenodd) and stroke
shape.loops.length;                   // 1 when the cards are adjacent, 2 when apart
```

`contains(shape.loops, x, y)` tests a point.

## Why every card stays closable (R7)

Splitting only ever replaces one card with two (R4), so the arrangement is always
a **slicing** floorplan. A pinwheel — four cards each overhanging the one in the
middle, so no side can take its place — is the canonical arrangement that is not,
and splitting cannot reach it.

Closing preserves that. It lets a whole row of neighbours grow together, not just
a single matching one, and only accepts a side that leaves the arrangement
slicing. In such an arrangement that side always exists.

Fixed cards never fill a gap — their size is their own — so a card standing
between two of them has no neighbour that can grow. It leaves the other way: it
reaches from one side of the plane to the other, so every slot it spans is its
own, and those slots simply go. How many there are makes no difference.

Together that makes `canClose` true for every card except the last, whatever has
happened before. `grid.isSlicing()` checks the underlying property directly.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `gap` | `24` | Corridor between cards, px. Half of it insets every inner edge and is the outline's `pad`. |
| `minSize` | `96` | Smallest card edge, px. |
| `grabSize` | `11` | Smallest grab area, px. Apart from `gap`, so `gap: 0` is still draggable. |
| `snap` | `"merge"` | A dragged boundary snaps onto a neighbour it nearly meets and the two become one line. `"off"`: neither. |
| `snapDistance` | `7` | How close it must come, px. |
| `fillOrder` | `"v"` | Which axis a close tries first: `"v"` from above/below, `"h"` from the sides. |
| `width`, `height` | `0` | Plane size. `resize(w, h)` updates it; the view does this for you. |

## API

`Soksak`

| | |
| --- | --- |
| `cards`, `card(id)`, `rect(id)`, `rects()`, `rectOf(card)` | read the arrangement |
| `resize(w, h)`, `width`, `height` | plane size |
| `canSplit(id, axis)`, `split(id, axis, {id?, data?})` | cut one card in two |
| `splitToward(id, side, {id?, data?})` | cut it and put the new one on a named side |
| `canClose(id)`, `close(id)`, `fill(id)` | remove a card; `fill` reports which neighbours take the space |
| `canMove(id, targetId, side)`, `move(id, targetId, side)` | take a card to another card's side |
| `standings(axis)`, `canInsertAt`, `insertAt`, `moveTo` | a card that reaches across the plane |
| `zoneAt(x, y, options)` | where a drop lands |
| `dividers()`, `rules()` | grab areas, and boundaries to draw |
| `boundaryPos`, `boundaryRange`, `moveBoundary`, `centerBoundary` | drag a boundary |
| `mergeCoincident(axis, line)` | fold a line onto the neighbour it now coincides with |
| `tidy()`, `virtualCount()`, `isVirtual(axis, line)`, `crossings(card)`, `cardsCrossing(axis, line)` | virtual lines |
| `isSlicing()`, `lines(axis)`, `toJSON()`, `Soksak.from(state)` | inspection and state |

`SoksakView` — `render(reason?)`, `element(id)`, `destroy()`.

`outline(rects, options)`, `unionLoops(rects)`, `roundedPath(loop, radius, innerRadius)`,
`contains(loops, x, y)`.

## License

MIT
