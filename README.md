# soksak

Pane layout over shared grid lines. Headless core, optional DOM binding, no runtime dependencies.

## The rules

**R1 — A boundary is one number.**
`xs` and `ys` hold every coordinate. A card is a span of indices into them, so
two cards that meet read the same index and their shared boundary is one number.
No tolerance decides where a card is or whether two cards meet.

Tolerance is used in three places, none of them for that: `snapDistance` sets
how near a drag must come before it lands on a neighbouring line;
`mergeCoincident` compares two coordinates a snap has already made equal; and
the outline treats two corners at the same point as one.

**R2 — Everything is a card.**
Sidebar, rail and pane use one type, one rect rule, one corridor, one radius,
one outline.

A card may carry a `width` or `height` in px. That is an attribute, not a second
type: no operation is refused because a card has one.

`fixed` is separate and applies to the layout. A `fixed` card is not split,
closed, moved or grown by the layout. A direct call to `moveTo` still moves it,
since that changes no other card's spans and no line on the other axis. `move`
refuses it, since a drop rearranges the cards around it.

**R3 — A card occupies its slots, so nothing can cross it.**
A card holding a column guarantees no other card spans across it. `canInsertAt`
counts spans rather than comparing coordinates.

**R4 — Splitting replaces one card with two.**
So the arrangement is always a slicing floorplan, a pinwheel is unreachable, and
every card stays closable.

**R5 — The corridor is half a gap on every inner edge.**
A card at the plane's border is flush there. A line no card references takes no
corridor. When the corridor total exceeds the plane, the gap is reduced to what
the plane holds. A slot can still end up narrower than the corridor it carries;
the card there is drawn with no width, in the middle of its slots, so a rect is
never inside out.

The slot carries the corridor, so a px size is the drawn size: `width: 180`
draws 180 at the plane's edge, between two cards, and at any `gap`.

The slots always sum to the plane. A px size is honoured while the plane has the
room; when it does not, every px size is scaled by one factor. A card that
arrives takes its span from the whole plane in proportion.

A px size describes one slot, so a cut divides it between the halves. A card
spanning two slots carries no px size.

**R6 — Rects are computed in one place.**
`geometry.ts` computes card rects, boundary rules and grab areas.
`soksak.ts` holds the state.

**R7 — A card can leave unless the layout may not move what would replace it.**
Every open card but the last can be closed, and the result is again an
arrangement splitting could have built. There are two ways out: a row of
neighbours grows over the space, or the card's slots are removed.

A `fixed` card does not grow over a departing neighbour, so a card whose only
filler is `fixed`, and whose slots hold another card, stays. `canClose` reports
this before anything moves.

## Install

```sh
pnpm add github:min-median-max/soksak
```

Install from git. The npm name `soksak` is taken by an unrelated package.
`dist/` is committed, so there is no build step.

ESM only. There is no CommonJS build.

## The model

```
xs   vertical grid lines,   normalised 0..1 over the sharing slots
ys   horizontal grid lines
```

A card is `{ id, c0, c1, r0, r1 }`: the slots it occupies. Moving a line moves
every card referencing it. A card spanning across the line is unaffected, and
for that card the line is unreferenced. A later split snaps to it, so splits in
different rows line up.

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

`width` sets the card to 180px across; the rest share the remainder. `fixed`
stops the layout splitting, closing or moving it. The same card in a middle
column is a rail. Only a card spanning one slot can set a px size on that axis.

Everything else reads the same for every card:

```js
grid.rects();               // Map<id, {x, y, w, h}>
grid.split("terminal", "x");
grid.close(id);
grid.move("rail", "browser", "right");
```

## Quick start — DOM

`SoksakView` sets position, manages element lifecycle and handles pointer
input. Card elements come from `createCard`. The elements the view creates carry
a class name and data attributes only.

```js
import { Soksak, SoksakView } from "soksak";

const host = document.querySelector("#stage");   // needs position: relative
const grid = new Soksak();

const view = new SoksakView(host, grid, {
  createCard(card) {
    const el = document.createElement("article");
    el.className = "card";
    el.append(mySurfaceFor(card.id));            // reused across renders
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
focused) centres it so the two cards beside it come out the same size. That
holds beside a card with a fixed width too — a width is a number and a number
has a half. A host that does not want a sidebar centred by a double-click should
not hand that divider the gesture.

**A card's child can inflate the rect the view set.** A flex or grid child
defaults to `min-width: auto`, so a column stretches to min-content and the
element reports a rect wider than the size it was given. `overflow: hidden` hides
that but does not shrink the rect, and anything positioned from it that the card
does not clip — an OS-level view composited over the page, for instance — lands
outside the card. Give the children `min-width: 0`.

## Boundaries

A drag changes the two slots that meet at the boundary and no others. Next to a
card holding its slot at a fixed size it changes that size and the slot on the
other side pays for it; anywhere else it moves the line and both sides follow.

The same rule settles a card that appears or disappears. A closing card's width,
and the corridor it releases, go to the slot next to it; a card inserted at a
boundary takes its width from the slot next to it. So a sidebar switched off and
back on leaves every other card the width it had.

A px size is declared by the host. Only a drag changes one — a close or an insert
settles with a sharing slot, and looks further out when the nearest one cannot
give the room without taking a card below `minSize`.

```js
grid.dividers();                       // where each boundary can be grabbed
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
grid.setFixed("rail", true);           // the layout does not move it
grid.setSize("rail", "x", 210);        // and this is how wide it is; null shares
grid.setData("rail", { pty: 3 });      // host payload
grid.moveTo("rail", "x", 4);    // a column leaves and a column arrives
```

Travelling that way closes nothing and splits nothing. The slot itself moves:
the cards it passes shift by its span, every other line keeps the coordinate it
had, and no boundary on the other axis moves. Between interior boundaries no
other card changes width at all.

Landing on the plane's border is the one exception. A border charges no
corridor, so the rail there costs half a gap less, and the card that was flush
against the border now has the rail beside it and pays half a gap. Every card
keeps its share of the plane; what moves is the corridor drawn next to it.

## Moving a card

Dragging a card somewhere else is one operation, not a close and a split the
caller sequences. The order matters: closing first gives the space back and
changes the target's geometry, so the cut is measured after that, and a close
that cannot happen leaves the whole move undone rather than half of it.

```js
grid.canMove("terminal", "browser", "right");   // asking is not doing
grid.move("terminal", "browser", "right");      // false, and unchanged, if refused
```

The card keeps its id, its payload and its px size.

`splitToward(id, side, init)` places a new card on a named side. `split` gives
the far half to the new card, so `left` and `top` swap the two spans. Ids are
not swapped.

## Where a drop lands

```js
grid.zoneAt(x, y, { headerPx: 34, footerPx: 24, centreOnly: draggingId });
// → { id, zone: "centre" | "left" | "right" | "top" | "bottom" } | null
```

`centre` means the card itself. A side means a new place beside it.
`headerPx` and `footerPx` are excluded, so chrome does not read as a side. The
edge band is a fraction of the body, not px.

## The outline

Cards separated by a corridor do not touch, so their plain union falls apart into
one loop each. Grow them first: at `pad = gap / 2` the grown rects meet on the
corridor centre line and the union closes into one shape. Every right angle
becomes an arc, including the reflex corners of an L.

```js
import { outline } from "soksak";

const rects = ["left", focused].map((id) => grid.rect(id)).filter((r) => r !== undefined);
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

Together that makes `canClose` true for every open card except the last,
whatever has happened before — apart from the R7 case above, where a card's only
filler is `fixed` and its slots hold another card. `canClose` returns false for a
`fixed` card, because the layout does not move it; clear the flag with `setFixed`
first.
`grid.isSlicing()` checks the underlying property directly.

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
