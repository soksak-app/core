# soksak

Korean translation: [`README.ko.md`](README.ko.md).

Pane layout over shared grid lines. Headless core, optional DOM binding, no runtime dependencies.

## The rules

**R1 — A boundary is one number.**
`xs` and `ys` hold every coordinate. A card is a span of indices into them, so
two cards that meet read the same index and their shared boundary is one number.
No tolerance decides where a card is or whether two cards meet: those are
integer indices, and two cards that meet read the same one.

Tolerance decides other things — how near a drag must come before it lands on a
neighbouring line, whether an operation left a card enough room, whether a
corner is tight enough to draw square — and every one of those is a judgement
about px, never about which card is where.

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
the plane holds. Lines standing at one place are one boundary: the slot beside
the run carries the corridor, because a slot with no width has nothing to carry
one with. A card whose own two lines stand at that one place has no width to
draw; it sits there, inside the one gap that keeps its neighbours apart, so a
rect is never inside out.

The slot carries the corridor, so a px size is the drawn size: `width: 180`
draws 180 at the plane's edge, between two cards, and at any `gap`.

The slots always sum to the plane, and a px size is reduced to keep that true.
It is drawn as declared while some slot on the axis shares and the plane has the
room.
When the plane does not, every px size is scaled down by one factor, so their
proportions survive and the sharing slots keep a floor. When no slot on the axis
shares, the px sizes are the only thing that can cover the plane, so they are
scaled to it in both directions and the declared numbers become proportions:
one card declaring 200 in a 1600 plane is drawn 1600, and two declaring 200 and
300 are drawn 630 and 946. Read `rect(id)` for what a card is drawn at.

A plane too small for what it holds cannot give every card its minimum. The
card's width is reduced and the gap beside it is not: a sharing slot stops at the
corridor it carries, the rest divide what is left, and the card that ran out of
room is drawn with no width against its near edge. The corridor between any two
neighbours is still exactly `gap`, and the plane is still covered exactly.

`minSize` binds the operations, not the plane. Splitting, closing, inserting and
dragging each refuse to take a card below it; `gap`, `minSize` and `resize`
re-express the same proportions at the new scale instead. So a sharing card
standing on the floor is drawn below it once the gap grows — by half a gap for
every interior line it touches — even where the plane still has the room. Nothing
is rewritten: set the gap back and the card is drawn what it was, to the last
bit. A card that must keep a size whatever the gap declares one with `setSize`,
which is drawn as declared at any `gap`.

A card that arrives takes its width from the slot next to it, as a drag does.

A px size describes one slot, so a cut divides it between the halves. A card
spanning two slots carries no px size.

**R6 — Rects are computed in one place.**
`geometry.ts` computes card rects, boundary rules and grab areas.
`soksak.ts` holds the state. `dom.ts` computes one rect of its own, the area
a rule is drawn in, because that one depends on the frame around the plane,
which only the host knows.

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

The rest of the API is the same for every card:

```js
grid.rects();               // Map<id, {x, y, w, h}>
grid.split("terminal", "x");
grid.close(id);
grid.move("rail", "browser", "right");
```

## Quick start — DOM

`SoksakView` sets position, manages element lifecycle and handles pointer
input. It also handles mouse input, for a host that delivers a press as mouse
events: `mousedown` on the divider, and `mousemove` and `mouseup` on the
divider's document. Card elements come from `createCard`. The elements the view
creates carry a class name and data attributes only.

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

| Element | Class | Attributes the view writes | Inline style |
| --- | --- | --- | --- |
| card, from `createCard` | yours | `data-card-id` | `position`, `left`, `top`, `width`, `height` |
| grab area | `sp-divider` | `data-axis`, `data-line`, `data-dragging` while held, `tabindex="0"`, `role="separator"` | the same, plus `touch-action: none` |
| boundary line | `sp-rule` | `data-axis`, `data-virtual` | the same, plus `pointer-events: none` |

`data-virtual` on a rule marks a rule that runs the whole plane rather than only
where cards break on the line. `isVirtual` reports something else: whether any
card reads the line at all.

```css
#stage { position: relative; }
.card { box-sizing: border-box; }
.card > * { min-width: 0; }                /* see the hazard below */
```

## The lines and the dividers

The view places them and decides nothing about how they look. `installTheme`
puts a stylesheet in the document that does: the cursor for each axis, a thin
grip inside the grab area, and the crossing part of a line drawn fainter than
the rest. The view sizes that area itself, `grabSize` or the gap, whichever is
larger.

```js
import { installTheme } from "soksak";

installTheme(document);
```

It reads its colours and sizes from tokens, so a host with colours of its own
points them at those and changes nothing else. The tokens follow the view's
`classPrefix`, and `themeTokens()` reports their names.

```css
:root {
  --sp-line: var(--border);
  --sp-line-crossing: var(--border-faint);
  --sp-grip: var(--text-faint);
  --sp-grip-active: var(--accent);
  --sp-grip-thickness: 3px;
  --sp-grip-length: 24px;
}
```

Light and dark are the host's: it already changes those colours when its theme
changes, and these change with them. Nothing here reads a host's token names or the
mode in effect.

The grip's colour changes over 0.12s when a divider is hovered, focused or
held. That transition is the sheet's only animation and no token sets it, so
the sheet turns it off itself under `prefers-reduced-motion: reduce`. It is the
one rule here that reads a setting, and that setting is the person's rather
than the host's.

`themeCSS()` returns the same stylesheet as text, for a host that puts it in a
file of its own rather than in the document. It carries that rule; a host that
writes its own sheet from `themeTokens()` writes the rule itself.

Dragging a divider moves the boundary. Double-clicking it (or Enter/Space when
focused) centres it so the two cards beside it come out the same size. That
holds beside a card with a fixed width too — a width is a number and a number
has a half. A host that does not want a sidebar centred by a double-click should
not hand that divider the gesture.

A gesture follows the changes the view makes: a drag, a centring and a merge each
renumber lines, and the divider under the finger is carried to the line its own
boundary now has. A change the host makes to the grid carries no gesture, because
the view is told of it by `render()`, after it happened, and a card that arrives
or leaves moves both the number a line has and where it stands. So a gesture is
settled against such a change instead: a boundary still within the width its
divider is grabbed at is the same handle and the gesture keeps it, and a boundary
further away than that is one the gesture never took hold of, so the gesture ends
there — the divider stops carrying `data-dragging` and the next move drives
nothing.

The settle runs wherever such a change first reaches a gesture: at the `render()`
the host makes, whatever reason it names there, at a resize, and at the press, key
or move itself, because a host that changes the grid and renders later leaves
those arriving in between. So a press on a divider whose boundary the host has
moved further than the divider is grabbed at takes no hold either. While a
`commit` hook holds a draw of a change the view made, the divider is behind by
that change, which the gesture was carried through, and a press then takes hold
as usual — of the boundary that gesture holds, because the number the divider
carries is written by the paint the host has not performed. Where the change
dropped a line, every other divider carries a number that renumber moved, and a
press on one of those takes no hold until the draw is done. A draw `render()`
hands over is not one of these at all: the view is not told whether the host
changed the grid before that call, so every `render()` is one that may have.

**A card's child can inflate the rect the view set.** A flex or grid child
defaults to `min-width: auto`, so a column stretches to min-content and the
element reports a rect wider than the size it was given. `overflow: hidden` hides
that but does not shrink the rect, and anything positioned from it that the card
does not clip — an OS-level view composited over the page, for instance — lands
outside the card. Give the children `min-width: 0`.

## Boundaries

A drag changes the two slots that meet at the boundary and no others. Next to a
card holding its slot at a fixed size it changes that size and the slot on the
other side is reduced by the same amount; anywhere else it moves the line and
both sides follow.

Where the plane holds less than the px sizes an axis declares, every declared
size is drawn scaled by one factor, and a boundary with such a size on exactly
one side of it does not move: changing the declared size rescales every other
card declaring one, and the sharing slots always divide the same remainder
between them. `boundaryRange` reports that by returning the position the
boundary stands at twice, and centring it does nothing for the same reason. A
boundary with a declared size on both sides still moves, because the pair keeps
the size it declares between them.

Beside a card with a px size, the range a boundary can reach also ends where the
sharing slots hit their floor — a gap each plus one card's minimum.
`boundaryRange` measures the two cards that meet the boundary, so on a plane
close to that floor it can report a little more room than the boundary can take,
and a target past it leaves the boundary where it is.

The same happens with no px size on the axis at all. A plane too small for what
it holds stops a sharing slot at its corridor, and a stopped slot does not move
with its span, so the px a boundary stands at stops following its coordinate:
positions inside the range cannot be drawn, and a whole coordinate span can
produce only a few positions in all. A drag asking for one that cannot be drawn
lands on one that can, which may be outside the range. `boundaryRange` bounds a
drag; it does not list where the drag can stop.

The same rule settles a card that appears or disappears. A card inserted at a
boundary takes its width from the slot next to it, or from one further out when
the nearest cannot give it without taking a card below `minSize`, and the slot
that gave it is recorded. A closing card's width, and the corridor it releases,
go back to that slot. So a sidebar switched off and back on leaves every other
card the width it had, as long as nothing moved in between and the plane holds
what the axis declares both times. After the arrangement changes, the close
returns the width to the slot that gave it while the insert takes it from the
slot that can give it now, and those are not always the same slot. Where the
plane does not hold what the axis declares, every declared size is drawn scaled
by one factor; that factor changes when a card arrives or leaves, and the widths
it drew cannot be restored by giving the space back.

A px size is declared by the host. A drag changes one, and a cut divides one
between the halves; a close or an insert settles with a sharing slot, and looks
further out when the nearest one cannot give the room without taking a card
below `minSize`.

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
card spans over, and every card past it is shifted by its span.

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

Landing on the plane's border is the one exception. A border takes no corridor,
so the rail there uses half a gap less, and the card that was flush against the
border now has the rail beside it and gives up half a gap. Every card keeps its
share of the plane; what moves is the corridor drawn next to it.

## Moving a card

Dragging a card somewhere else is one operation, not a close and a split the
caller sequences. The order matters: closing first gives the space back and
changes the target's geometry, so the cut is measured after that, and a close
that cannot happen leaves the whole move undone rather than half of it.

```js
grid.canMove("terminal", "browser", "right");   // reports; changes nothing
grid.move("terminal", "browser", "right");      // false, and unchanged, if refused
```

The card keeps its id and its payload. It keeps its px size only when it lands
spanning one slot on that axis: a card spanning two carries none (R5), so a move
onto a side that widens it drops the size.

`splitToward(id, side, init)` places a new card on a named side. `split` gives
the far half to the new card, so `left` and `top` swap the two spans. Ids are
not swapped.

## Where a drop lands

```js
grid.zoneAt(x, y, { headerPx: 34, footerPx: 24, edge: 0.25, centreOnly: draggingId });
// → { id, zone: "centre" | "left" | "right" | "top" | "bottom" } | null
```

`centre` means the card itself. A side means a new place beside it.
`headerPx` and `footerPx` are excluded, so a point on the chrome returns the
card, not a side. `edge` is how much of the body each edge claims, as a fraction
of it rather than px; it defaults to `0.25` and a value outside `0..0.5` is
refused, as an option out of range is everywhere else.

## The outline

Cards separated by a corridor do not touch, so their plain union falls apart into
one loop each. Grow them first: at `pad = gap / 2` the grown rects meet on the
corridor centre line and the union closes into one shape. A right angle becomes
an arc where the radius fits, including the reflex corners of an L; the radius
is capped at half the shorter of the two sides meeting there, and a corner too
tight for an arc is drawn as a straight cut. `Outline.corners` counts the
corners and `Outline.sharp` how many were cut.

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
| `snap` | `"merge"` | A dragged boundary snaps onto a neighbour it nearly meets. `mergeCoincident` folds the two into one line, which `SoksakView` calls when the pointer is released. `"off"`: neither. |
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
| `setFixed(id, on)`, `setSize(id, axis, px)`, `setData(id, data)` | change a card; the returned copies are frozen |
| `standings(axis, without?)`, `canInsertAt(axis, line, without?)`, `insertAt`, `moveTo` | a card that reaches across the plane |
| `zoneAt(x, y, options)` | where a drop lands |
| `dividers()`, `rules()` | grab areas, and boundaries to draw |
| `boundaryPos`, `boundaryRange`, `hasBoundary(axis, line)`, `moveBoundary(axis, line, px, allowSnap?)`, `centerBoundary` | drag a boundary |
| `mergeCoincident(axis, line)` | fold a line onto the neighbour it now coincides with |
| `tidy()`, `virtualCount()`, `isVirtual(axis, line)`, `crossings(card)`, `cardsCrossing(axis, line)` | virtual lines |
| `isSlicing()`, `lines(axis)`, `toJSON()`, `Soksak.from(state, options?)`, `checkState(state)`, `replace(state)` | inspection and state |
| `gap`, `minSize`, `grabSize`, `snapDistance`, `snap`, `fillOrder` | the options, readable and writable after construction |

Every method taking an axis refuses one that is not `"x"` or `"y"`; every method
taking a side refuses one that is not `left`, `right`, `top` or `bottom`. A
refusal returns `null`, `false` or an empty answer and changes nothing.

`toJSON()` carries `paidBy`, which records the card each slot was taken from, so
a grid rebuilt from it closes cards the same way. `checkState` is what the
constructor runs; call it to reject a stale saved layout before installing one.

`SoksakView(host, grid, options)` — `render(reason?)`, `element(id)`,
`destroy()`. Options: `createCard` (required), `updateCard`, `destroyCard`,
`onChange(reason)`, `updateDivider`, `rules` (default on), `commit(rects, draw)`,
`classPrefix` (default `sp`), `observeResize` (default on), `bleed` (default 0).

`commit(rects, draw)` runs before every layout change the view makes, not only a
drag. It receives the rects the render is about to write — the same values the
elements get, on the device's pixel grid — and calls `draw` to perform it. A host
that places its own views over the plane moves them in the same frame.

`bleed` is how far past the plane a rule may run to reach the frame around it.
A host that holds the plane inside a frame — a padding on the element outside
it — draws its border that far from where a rule ends, so the rule stops short of
that border. Only the host has that distance: the view receives an
element, and an element's own padding does not move what is placed absolutely
inside it. Only the ends that reach the plane bleed; a rule that stops against
a card is left where it stops, because the card is the edge it reaches.

It is writable on the view — `view.bleed = px` — because a host that lets a
person change its gap changes this with it.
`reason` is one of `drag`, `center`, `merge`, `resize`, `render`.

`outline(rects, options)`, `unionLoops(rects)`, `roundedPath(loop, radius)`,
`contains(loops, x, y)`.

## License

MIT
