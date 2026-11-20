# soksak

Korean translation: [`layout.ko.md`](layout.ko.md).

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

An identifier names a card; it does not determine its role. Renaming identifiers
and permuting the input card array preserve geometry, query decisions and
corresponding operation results. Opaque card data is unchanged by renaming.

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

A box ([the model](#the-model)) draws a frame around its inner node: the frame
stands one corridor inside the box on its left, right and bottom side, and the
head of the box (`setHeads`) on its top. The frames and the heads are fixed costs
of the cut that holds the box, so a card stands one corridor from the frame
around it, the frame one corridor from the next frame, and a box one corridor
from its neighbour across the line. A frame takes the corridor of its axis,
reduced with it when the plane cannot hold the corridors and the frames. A px
size is the drawn size of a card inside the frames around it. The frames follow
from the tree and are no part of the state.

The option `frames` states what a frame takes: `"corridor"`, the default, one
corridor as above; `"none"` nothing, so a box is drawn at the rectangle of its
inner node, its head still inside its top, and the corridor between two boxes on
the two sides of a line is one corridor however many boxes end on the line. A
host whose corridor is the one border line that two boxes share sets `"none"`.
A change of `frames` keeps every fraction, and a value that is no frame mode
throws `soksak: frames is <value>; use "corridor" or "none"`.

The slots always sum to the plane, and a px size is reduced to keep that true.
It is drawn as declared while some slot on the axis shares and the plane has the
room.
The drawn size of a kid that shares is its fraction of the extent of its level
less the fixed costs of the level: the corridors, the `fixed` cards with a px
size, and the heads and frames of boxes. A `fixed` card with a px size is a
cost of its level, as a corridor is, and no kid that shares; a card with a px
size that is not `fixed` is a kid that shares. So the px sizes fall into two
classes:

- A `fixed` card keeps its px size while the plane holds the costs of its level
  and one `minSize` for the kids that share; only a plane that does not hold
  them scales the `fixed` cards, by one factor. A corridor, frame or head that an
  operation adds or removes is paid by the kids that share.
- When the plane does not hold the px sizes of the kids that share, those px
  sizes are scaled down by one factor, so their proportions survive and the
  kids that take a fraction keep a floor of one `minSize`. The floor does not
  count the corridors, frames and heads inside the kids that take a fraction;
  only a room that does not hold those costs scales the px sizes further.

When no slot on the axis
shares, the px sizes are the only thing that can cover the plane, so they are
scaled to it in both directions and the declared numbers become proportions:
one card declaring 200 in a 1600 plane is drawn 1600, and two declaring 200 and
300 are drawn 630 and 946. Read `rect(id)` for what a card is drawn at.

A plane too small for what it holds cannot give every card its minimum. The
corridor of an axis is the gap capped at the extent over the lines and frames
that hold one, and a cut that still cannot hold its corridors and frames narrows
the corridor of its axis by halves, down to none. Each kid is drawn at least the
corridors, px sizes, frames and heads inside it, and the kids that take a
fraction divide the rest by their fractions, so a small fraction is drawn below
`minSize` and the plane is still covered exactly.

`minSize` binds the operations, not the plane. Splitting, closing, inserting and
dragging each refuse to take a card below it; `gap`, `minSize` and `resize`
re-express the same fractions at the new scale instead. So a sharing card
standing on the floor is drawn below it once the gap grows — by its fraction of
the corridors that the gap adds — even where the plane still has the room.
Nothing is rewritten: set the gap back and the card is drawn what it was, to the
last bit. A card that must keep a size whatever the gap declares one with `setSize`,
which is drawn as declared at any `gap`.

A card that arrives takes its size by the rule of an ADD
([add and remove](#add-and-remove)).

A px size belongs to its card of the tree, so a cut of the card divides it
between the halves, and the lines of other cuts that fall inside the card do
not change it: a card that spans two slots of the lines keeps its px size.

**R6 — Rects are computed in one place.**
`geometry.ts` computes card rects, boundary rules and grab areas.
`soksak.ts` holds the state. `dom.ts` computes one rect of its own, the area
a rule is drawn in, because that one depends on the frame around the plane,
which only the host knows.

**R7 — A card can leave unless the layout may not move what would replace it.**
Every open card but the last can be closed, and the result is again an
arrangement splitting could have built. The card leaves its cut, and the other
kids of that cut take its share by one factor, so their ratios hold. A cut left
with one kid is replaced by that kid, and a card that fills a cut alone has no
px size on the axis of that cut.

A `fixed` card keeps its size when a sibling leaves, so a card whose cut holds
only `fixed` cards besides it stays. `canClose` reports this before anything
moves.

## Install

```sh
pnpm add github:soksak-app/core#path:packages/soksak
```

Install from git. The npm name `soksak` is taken by an unrelated package.
`dist/` is committed, so there is no build step.

ESM only. There is no CommonJS build.

## The model

The state of a grid is its slicing tree, and the tree is the stored form: the
lines and the cells are derived from it, and the tree is never read back from
them.

```
state  {root}
root   a node
node   {card, data?, fixed?, width?, height?}     a card
       {box, data?, inner}                        a box of the host around a node
       {cut, kids: [{share, node}, ...]}          a cut along the axis cut ("x" or "y")
```

A cut divides the rectangle of its node along its axis into its kids in their
order, each kid taking `share` of the extent of the cut: the shares are positive
and sum to 1. The tree is canonical: a cut has at least two kids, and no kid of
a cut is a cut along the same axis, so a row of five cards is one cut of five
kids however it was built. A box is a rectangle that the host draws around the
node `inner`, such as a group card of a workbench, with the data of the host in
`data`; the layout keeps it one child of its cut, so no operation lays a card
across it, and `setHeads({id: px})` gives the px that the host draws inside the
top of a box above its inner node, which the drawn sizes and the minimum count.
The heads, like the frames, are no part of the state. Every card and every box
has an id that names it once in the tree.

The lines are the coordinates at which the rectangles of the nodes start and
end, from 0 to 1 over the sharing slots of an axis: `xs` the vertical ones and
`ys` the horizontal ones. Coordinates within a billionth are one line, so the
rectangles of two cuts that end at one coordinate draw one line, and a card is
`{id, c0, c1, r0, r1}`, the cells between the lines that its rectangle starts
and ends at, as the geometry of the rules reads it (R1, R5). Two seams of two
cuts that stand at one line are still two seams: an operation of the tree reads
the cut that a card or a box belongs to from the tree, so a line that two rows
share by chance changes no result. A boundary drag moves a line that the person
sees, so it moves every seam that stands on that line, and each moves in its own
cut ([boundaries](#boundaries)).

The state records no payer: a close gives the share of the card to the other
kids of its cut by one factor (R7), so the space of a card does not depend on
the card it came from.

`Soksak.from(state, options?)`, the constructor, `replace(state)` and
`checkState(state)` read only this form. A state that holds `xs`, `ys` or
`cards`, which is the form of the earlier releases, throws `soksak: the state
holds xs, ys and cards, which is the earlier form; the state is {root}`; a state
that holds `paidBy` throws `soksak: the state holds paidBy, which the layout does
not record; the state is {root}`, and a state with another member besides `root`
throws `soksak: the state holds <members>; the state is {root}`;
a node of another form throws `soksak: the node <json> is not a card, a box or a
cut`; a cut with fewer than two kids, a kid cut along the axis of its cut, or
shares that are not positive or do not sum to 1 within a billionth throw
`soksak: the cut <path> is not canonical: <reason>`; and an id that names two
nodes throws `soksak: card <id> is stored twice`. Nothing is converted.

### Why the tree is the state

The earlier state was the lines and the cells, and each operation rebuilt the
slicing tree from them. Two cuts whose lines stood at one coordinate by chance
read as one cut, so an operation of one row changed the other: over 32 seeds of
40 generated operations, the invariants I7, I8 and I10 of
`docs/plans/layout-sizes.md#invariants` failed 63 times, each on a layout whose
lines read as more than one tree, and none on another layout
(`docs/spec/cases/layout/invariants.json`).

Objections and answers:

- *The lines are the contract of the geometry (R1, R5), and a tree is a second
  description of the same layout.* The tree is the only description that is
  stored; the lines are computed from it on every change, as the rectangles are
  computed from the lines, so no reader holds two forms.
- *A later split in another row that snaps to a line no longer joins the rows.*
  A split still lands on a line that stands within its snap distance, and the
  two rows draw one line; the rows stay two cuts, so a later operation of one
  row does not move the other. A boundary drag of that line moves both, because
  the person drags the line that is drawn.
- *A close can no longer give the space of a card to neighbours that line up
  with it by chance.* Such neighbours are no kids of the cut of the card, so
  giving them the space would cross the structure of another cut; the close
  gives it to a kid of its own cut, which R7 always finds, since every cut has
  at least two kids.
- *The stored layouts of the earlier releases stop opening.* While the release
  is 0.0.x no stored format is settled: the reader refuses the earlier form
  with an error that names the file, and every file of the repository that
  holds a layout is written in the tree form in the change that makes its
  reader read it ([persistence](../../../docs/spec/projects.md#persistence)).

## A sidebar is a card

```js
const grid = new Soksak({
  root: { cut: "x", kids: [
    { share: 1 / 3, node: { card: "left", width: 180, fixed: true } },
    { share: 2 / 3, node: { cut: "y", kids: [
      { share: 0.5, node: { card: "terminal" } },
      { share: 0.5, node: { card: "browser" } },
    ] } },
  ] },
}, { width: 1200, height: 800 });
```

`width` sets the card to 180px across; the rest share the remainder. `fixed`
stops the layout splitting, closing or moving it. The same card in a middle
column is a rail. A px size belongs to the card, whatever slots it spans.

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
| card, from `createCard` | yours | `data-card-id`, `data-fullscreen`, `hidden` | `position`, `left`, `top`, `width`, `height` |
| grab area | `sp-divider` | `data-axis`, `data-line`, `data-dragging` while held, `tabindex="0"`, `role="separator"` | the same, plus `touch-action: none` |
| boundary line | `sp-rule` | `data-axis`, `data-virtual` | the same, plus `pointer-events: none` |

`data-virtual` on a rule marks a rule that runs the whole plane rather than only
where cards break on the line.

```css
#stage { position: relative; }
.card { box-sizing: border-box; }
.card[hidden] { display: none !important; }
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

The settle runs at the `render()` the host makes, whatever reason it names there,
and nowhere else. **A host changes the grid and calls `render()` in the same
turn.** Nothing reaches a gesture in between, so a press, a key, a move or a
release always follows the render of the change before it, and each of those
paths reads a grid the elements agree with. A host that changes the grid and
renders later hands its gestures a boundary that has moved and does not say so;
the view has no way to be told of a change it is not told of.

While a `commit` hook holds a draw of a change the view made, the divider is
behind by that change, which the gesture was carried through, and a press then
takes hold as usual — of the boundary that gesture holds, because the number the
divider carries is written by the paint the host has not performed. Where the
change dropped a line, every other divider carries a number that renumber moved,
and a press on one of those takes no hold until the draw is done. A draw
`render()` hands over is not one of these at all: the view is not told whether
the host changed the grid before that call, so every `render()` is one that may
have.

**A card's child can inflate the rect the view set.** A flex or grid child
defaults to `min-width: auto`, so a column stretches to min-content and the
element reports a rect wider than the size it was given. `overflow: hidden` hides
that but does not shrink the rect, and anything positioned from it that the card
does not clip — an OS-level view composited over the page, for instance — lands
outside the card. Give the children `min-width: 0`.

## Boundaries

A boundary is the seams of the cuts along its axis that stand on its line, and a
drag moves each of them by the same px. Each seam changes the two kids of its
own cut that meet at it and no others: the kid before it is drawn larger by the
move and the kid after it smaller. A kid that keeps a px size takes the new size
at the scale it is drawn at; the kids that take a fraction take the fractions of
their new contents. A line of another cut is no limit, because the kids of
another cut do not change: a seam dragged past it passes it, and a seam dragged
onto it joins it, so the two seams stand on one line and a later drag moves them
together. `moveBoundary` returns the position the seam reached, read after the
lines are derived again, on the line it then stands on.

Where the plane holds less than the px sizes an axis declares, every declared
size is drawn scaled by one factor, and a boundary with such a size on exactly
one side of it does not move: changing the declared size rescales every other
card declaring one, and the sharing slots always divide the same remainder
between them. `boundaryRange` reports that by returning the position the
boundary stands at twice, and centring it does nothing for the same reason. A
boundary with a declared size on both sides still moves, because the pair keeps
the size it declares between them.

`boundaryRange` comes from the same seams. Each kid beside a seam can give what
it can lose before a card inside it is drawn below `minSize` and the heads inside
it: a card loses down to that, a box gives what its inner node gives, a cut across
the axis what its kid that can give least gives, and a cut along the axis shares
the loss among its kids that take a fraction in proportion to their contents. A
node that keeps a px size and is no card gives down to its recursive minimum
([cuts](#cuts)). The range is the position of the boundary less the smallest
amount the kids before the seams give and plus the smallest amount the kids
after them give. A kid drawn at its minimum or below gives nothing, so the range
always holds the position the boundary stands at. A move that would leave a card
with no area, as `minSize: 0` allows, changes nothing. `boundaryRange` bounds a
drag; it does not list where the drag can stop.

The same rule settles a card that appears or disappears. A card inserted at the
boundary between kids i and i+1 of the root is added beside kid i toward kid
i+1 ([add and remove](#add-and-remove)): when the kids of the root that take a
fraction have one fraction, or kid i holds a px size, every kid that takes a
fraction gives in proportion and keeps its ratio; otherwise kid i alone gives the
span, and every other kid keeps its fraction. When every kid holds a px size,
every kid gives a share.
A card inserted at an edge of the plane is added beside the root, so every kid
without a px size gives a share in proportion. An insert that would take a card
below `minSize` is refused. A closing card leaves its cut, and the fractions of
the other kids of the cut scale by one factor. A `fixed` card without a px size
is a fixed cost of its cut: it keeps the size it is drawn at when a kid arrives
or leaves beside it. So a sidebar switched off and back on leaves every other
card the width it had when the root is even; on an uneven root the kid that paid
for it keeps less than it gave.
Where the plane does not hold what the axis declares, the px sizes of the kids
that share are drawn scaled by one factor, which changes when a card arrives or
leaves in their cut; a `fixed` card keeps its px size while the plane holds the
costs and one `minSize` for the kids that share.

A px size is declared by the host. A drag changes one, and a cut divides one
between the halves; a close gives the span to the other kids of its cut, and an
insert takes it from the kid before the boundary or from every kid.

```js
grid.dividers();                       // where each boundary can be grabbed
grid.boundaryPos("x", 1);              // px
grid.boundaryRange("x", 1);            // [min, max] px, before something hits minSize
grid.moveBoundary("x", 1, 260);        // px
grid.centerBoundary("x", 1);
```

## Cuts

`even()` gives every kid of every cut of the tree ([the model](#the-model)) an
equal share, so the result depends on the arrangement and not on the order of
the operations that built it: a row of five cards is five equal cards, whether
it was built by halves or by thirds, and two rows that hold the same number of
cards draw their seams on the same lines.

A box `{box, data?, inner}` is a rectangle of the host that the tree keeps as
one kid of its cut, so no cut crosses it. `setHeads({id: px})` gives the px
that the host draws inside the top of each box above its inner node, the head
with the space below it; a box without an entry has no head. The card or the box
at the top of the inner node is drawn from the top of the box, so the head stands
inside its top. `setHeads` throws `soksak: heads name "<id>",
which is no box` for an id that is no box and `soksak: the head of "<id>" is
<value>` for a head that is negative or not finite, and the heads are no part of
the state.

Every rule of sizes works on the fractions of the tree. A cut first takes its
fixed costs from its extent: the corridors between its kids, the px sizes of the
kids that keep one, and the frames and heads of the boxes among its kids. Each
kid that takes a fraction is drawn its frames and heads and its fraction of the
rest, so kids of one fraction are drawn at one size inside their frames, at the
border of the plane as between two corridors. A kid is even with its siblings
when the kids of its cut that take a fraction have one fraction, and `even` gives
every such kid of every cut one fraction. A gap change, a head change and a
resize keep every fraction, so an ADD and a REMOVE on an even cut restore it
exactly whatever changed between them. A card with a px size on the axis of its
cut, and a `fixed` card, keep their size and take no fraction. A result below a
minimum throws as below, and a throw changes nothing.

The minimum of a node is recursive, with the heads and the corridors as fixed
costs: a card needs `minSize` and on `y` the heads drawn inside its rectangle,
a card with a px size the smaller of that size and `minSize`, a `fixed` card
with a px size the smaller of that size and the size it had, another `fixed`
card the size it is drawn at, a box what its inner node needs, a cut on its own
axis the needs of its kids and the corridors between them and across it the
largest need of its kids.
After an operation, every card and box whose rectangle changed is judged, and
the deepest one drawn below its need throws `card <id> would be <w>x<h>, below
its minimum <w>x<h>`: a box is below its need only where a node inside it is,
so the refusal names the node that has no room, a content card inside a box
before the box. A card is named at the size of its content: the heads drawn
inside its rectangle are taken out of the size it would have and of its need,
so its need is `minSize` or its px size. A box is named when no node inside it
is below its need, at its rectangle and its need.

Every operation is linear in the nodes that it touches: the tree keeps a map
from each id to its node and from each coordinate to its line, so no operation
scans the whole tree for one card. `visits` reads the number of nodes that the
last operation visited, which a test bounds on a large tree instead of a time.

```js
grid.setHeads({ "group-1": 44 }); // the head of a box
grid.even();                      // every cut even
grid.visits;                      // the nodes that even visited
```

### Add and remove

`withdraw(id)` takes the node `id`, a card or a box, out of its cut; the
fractions of the other kids of the cut scale by one factor, as a close does,
and a cut left with one kid is replaced by that kid. A kid of that kid that is a
cut along the axis of the cut that holds it joins that cut, and every kid keeps
the size it is drawn at. It returns the node that left, a card
node or a box node with its inner node, which `insert` takes, so a box lands
with its members in their proportions. The last card and a `fixed` card are
refused.

`insert(target, side, node)` adds `node`, a new card `{card, data?}` or what
`withdraw` returned, beside `target` toward `side` and returns its id;
`target` is an id or the ids that neighbouring kids of one cut hold. Along the
cut of the target, an even cut of k kids that take a fraction gives the node
1/(k+1) of their fractions and scales every other by k/(k+1), and a cut whose
fractions differ gives the node half of the fraction of the target and keeps
every other fraction; a node that keeps a px size takes its size from the kids
that pay, with the new corridor; when the target is the cut itself, the kid at the end toward `side` is
the target. Ids of neighbouring kids of one cut along the axis of the side are a
run inside that cut: the node is added to that cut beside the run, as beside a
kid, and the run is not wrapped in a cut of its own. Across the cut, the target
is wrapped in a new cut of two halves.
Only the cuts that the operation changes are laid again, so every other card
keeps its rectangle. A move is a `withdraw` and an `insert`.

`group(target, side, node, {box, data?, head})` is the group split of the card
or box `target`: a box with the id `box`, the payload `data` and a head of
`head` px takes the place of `target` in its cut, with its fraction, and its
inner node is a new cut of two halves along the axis of `side` that holds
`target` and `node` toward `side`. The head joins the heads of `setHeads`, and
the result is judged once with the head and the frames of the new box, so a
refusal names the deepest node that the group would draw below its minimum at
the size of its content under the head. Ids that the layout holds are refused.
`unwrap(id)` is the inverse: the inner node of the box `id` takes its place and
its head leaves with it, and a cut along the axis of the cut that holds the box
joins that cut with every kid drawn at the size it had. `close(id)` of a box
withdraws it with every card inside it, as a close of a card does.

```js
const left = grid.withdraw("card-3");             // the row closes the gap in proportion
grid.insert("card-1", "right", left);             // card-3 lands to the right of card-1
grid.insert(["card-1", "card-2"], "bottom", { card: "card-9" }); // a new row below both
```

The proposal of this rule is [layout sizes](../../../docs/plans/layout-sizes.md),
whose invariants `docs/spec/cases/layout/invariants.json` checks over generated
layouts in both languages.

## Even arrangement

`arrange("even")` replaces the arrangement with a grid of the cards in their
current order. It removes every split and every merge: the result has no card
that spans another, and no cut except the grid lines.

- The number of cards `n` is the number of cards of the layout.
- It chooses `rows` and `columns` so that `rows * columns` is `n` or `n + 1`.
  When `n + 1` is chosen, one empty card is added so the grid is complete.
- Among those choices it keeps the ones whose cell is at least `minSize` on both
  axes, and takes the one whose cell is closest to square. A tie goes to the
  choice with no empty card.
- The cards fill the grid in reading order: the first row left to right, then the
  next row.
- Every cell has the same drawn size.
- When no choice keeps every cell at least `minSize`, `arrange("even")` returns
  false and changes nothing.

The grid is the same for any plane size: a wider plane gets more columns, a taller
plane gets more rows.

```js
grid.arrange("even");
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

The card keeps its id, its payload and its px size, except on the axis of a cut
that it comes to fill alone, where it has no size of its own (R7).

`splitToward(id, side, init)` places a new card on a named side. `split` gives
the far half to the new card, so `left` and `top` swap the two spans. Ids are
not swapped. A refused split throws and changes nothing: an unknown axis or
side, an id that the layout holds, an unknown or `fixed` card, a card drawn no
wider than the corridor of the cut (`card <id> would be 0x<h>, below its
minimum <m>x<m>`, or `<w>x0` on `y`), and a cut that draws a node below its
minimum, which names the deepest such node.

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

The state is a slicing tree (R4), so a pinwheel — four cards each overhanging
the one in the middle, so no side can take its place — cannot be stored, and no
operation reaches it.

A close takes the card out of its cut and gives its share to the other kids of
the same cut by one factor, and every cut has at least two kids, so another kid
always exists. A `fixed` card keeps its size, so it takes no share; a cut or a
box that holds a fixed card takes a share like any other kid.

Together that makes `canClose` true for every open card except the last,
whatever has happened before — apart from the R7 case above, where every other
kid of the card's cut is a `fixed` card. `canClose` returns false for a `fixed`
card, because the layout does not move it; clear the flag with `setFixed`
first.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `gap` | `24` | Corridor between cards, px. Half of it insets every inner edge and is the outline's `pad`. |
| `minSize` | `96` | Smallest card edge, px. |
| `grabSize` | `11` | Smallest grab area, px. Apart from `gap`, so `gap: 0` is still draggable. |
| `snap` | `"merge"` | A dragged boundary snaps onto a line it nearly meets, and the two are then one line. `"off"`: no snap. |
| `frames` | `"corridor"` | What the frame of a box takes on its left, right and bottom side (R5). `"none"`: nothing. |
| `snapDistance` | `7` | How close it must come, px. |
| `width`, `height` | `0` | Plane size. `resize(w, h)` updates it; the view does this for you. |

## API

`Soksak`

| | |
| --- | --- |
| `cards`, `card(id)`, `rect(id)`, `rects()`, `rectOf(card)` | read the arrangement; `rect(id)` of a box is the rectangle around its frame |
| `resize(w, h)`, `width`, `height` | plane size |
| `canSplit(id, axis)`, `split(id, axis, {id?, data?, newLine?})` | cut one card in two; `newLine` cuts at a new line at the centre even where a line that the card spans across lies inside it |
| `splitToward(id, side, {id?, data?, newLine?})` | cut it and put the new one on a named side |
| `canClose(id)`, `close(id)` | remove a card, or a box with every card inside it; the other kids of its cut take its share by one factor and a fixed card keeps its drawn size (R7); false when the card is fixed or the last card, when the box holds every card that is not fixed, or when every other kid of the cut is a fixed card |
| `canMove(id, targetId, side)`, `move(id, targetId, side)` | take a card to another card's side: a close and an insert |
| `setFixed(id, on)`, `setSize(id, axis, px)`, `setData(id, data)` | change a card, and with `setData` the payload of a box; the returned copies are frozen |
| `unwrap(id)`, `headsAbove(id)` | put the inner node of the box `id` in its place without its head, a cut along the axis of its cut joining that cut with every kid at its drawn size; the px of the heads drawn inside the top of a card or a box ([add and remove](#add-and-remove)) |
| `standings(axis)`, `canInsertAt(axis, line)`, `insertAt`, `moveTo` | a card that reaches across the plane: the edges of the plane and the seams of the root cut along the axis |
| `zoneAt(x, y, options)` | where a drop lands |
| `dividers()`, `rules()` | grab areas, and boundaries to draw |
| `boundaryPos`, `boundaryRange`, `hasBoundary(axis, line)`, `moveBoundary(axis, line, px, allowSnap?)`, `centerBoundary` | drag a boundary |
| `even()`, `setHeads(heads)`, `visits` | give every kid of every cut that takes a fraction one fraction; the heads of the boxes; the nodes that the last operation visited ([cuts](#cuts)) |
| `withdraw(id)` | take a card or a box out of its cut; the fractions of the others scale by one factor ([add and remove](#add-and-remove)) |
| `insert(target, side, node)` | add a card beside a target: 1/(k+1) of an even cut, half of the target in an uneven cut, a wrap of two halves across ([add and remove](#add-and-remove)) |
| `group(target, side, node, {box, data?, head})` | put a box with its head in the place of a target and add the node inside it beside the target, judged once ([add and remove](#add-and-remove)) |
| `crossings(card)`, `cardsCrossing(axis, line)` | the lines a card crosses, and the cards that cross a line |
| `lines(axis)`, `toJSON()`, `Soksak.from(state, options?)`, `checkState(state)`, `replace(state)` | inspection and state |
| `gap`, `minSize`, `grabSize`, `snapDistance`, `snap`, `frames` | the options, readable and writable after construction |

Every method taking an axis refuses one that is not `"x"` or `"y"`; every method
taking a side refuses one that is not `left`, `right`, `top` or `bottom`. A
refusal changes nothing: `split`, `splitToward`, `insert`, `withdraw`, `group`
and `unwrap` throw it with its text, and every other method returns `null`,
`false` or an empty answer.

`toJSON()` returns `{root}`, and a grid rebuilt from it closes cards the same way,
because a close reads only the tree. `checkState` is what the
constructor runs; call it to reject a stale saved layout before installing one.

`fullscreen(id)` presents one existing card across the plane without changing the grid model. `fullscreen(null)` restores the arrangement. The `fullscreenCard` getter reports the current presentation choice. Other card elements remain alive but hidden; their presented rectangles have zero area. Rules and dividers are absent in fullscreen. Commit rectangles and the draw use the same snapshot, including during resize and asynchronous restore. Invalid IDs fail without changing state. A host restores normal presentation before removing the fullscreen card or changing the arrangement.

`SoksakView(host, grid, options)` — `render(reason?)`, `element(id)`,
`painted(id)`, `fullscreen(id)`, `fullscreenCard`, `destroy()`. Options: `createCard` (required), `updateCard`, `destroyCard`,
`onChange(reason)`, `updateDivider`, `rules` (default on), `commit(rects, draw, dividers)`,
`classPrefix` (default `sp`), `observeResize` (default on), `bleed` (default 0),
`boundary` (default the grid's operations), `drawn` (default the grid's arrangement).

`commit(rects, draw, dividers)` runs before every layout change. It receives the
rectangles on the device's pixel grid, and the dividers of the layout with the
rectangles that the draw gives their grab areas on that grid, which are none in
fullscreen. A host whose own views cover the cards gives the grab areas the
pointer over them. The host calls `draw()` after preparing its views.
Each callback draws the layout it received, once; a later grid change cannot
replace that layout before it is drawn, and a device pixel ratio that changes
before the draw does not change the rectangles it writes. The view draws again
on the new pixel grid when the ratio changes. A host that skips an older callback
skips that layout. DOM and native presentation require separate synchronization
in the host.

`painted(id)` returns the rectangle the last draw wrote to a card's element, or
`undefined` before the card is drawn. With a `commit` hook the grid holds a newer
layout than the elements until its draw runs, so a host that draws beside the
cards reads this rectangle instead of `rect(id)`.

The DOM binding observes display-resolution changes and redraws on the new
device-pixel grid even when the host's CSS size is unchanged. `destroy()` removes
this observation.

The view observes the size of its host from an animation frame, which runs
before the observation round of that frame, and `observation` states where that
stands: `refused`, `pending`, `observing`, `unavailable` or `stopped`.
`hostResized(width, height)` is the reaction to one observation of the host
size: it resizes the grid and returns whether the grid took the size; a
destroyed view and a host of zero width or height leave the grid as it is and
return `false`.

`bleed` is how far past the plane a rule may run to reach the frame around it.
A host that holds the plane inside a frame — a padding on the element outside
it — draws its border that far from where a rule ends, so the rule stops short of
that border. Only the host has that distance: the view receives an
element, and an element's own padding does not move what is placed absolutely
inside it. Only the ends that reach the plane bleed; a rule that stops against
a card is left where it stops, because the card is the edge it reaches.

It is writable on the view — `view.bleed = px` — because a host that lets a
person change its gap changes this with it.

`boundary` is a `BoundaryModel`, the boundary operations that every divider
gesture runs: `move(axis, line, px)` for a drag step, `step(axis, line, px)`
for an arrow key,
`center(axis, line)` for the second press of a pair and Enter, and
`end(axis, line)` at the end of a drag, which returns whether a line merged.
Without it the view runs `moveBoundary` and `centerBoundary` of the grid, and
`end` returns false, because a drag that reaches another line has joined it
already ([boundaries](#boundaries)). A host whose cards are drawn at other
rectangles than the grid's, and which holds rules of its own for a line,
supplies its own; a host that stores the result of a drag through an
operation of its own runs it in `end`, from where the drag left the boundary.
`drawn` is a `DrawnModel`, the arrangement the view draws: `rects(fullscreen)`
gives the rect of each card, and with a fullscreen id only the cards shown with
it, every other card being hidden; `rules()` gives the rules as `DrawnRule`s,
whose `bleed` false keeps a rule off the frame around the plane; `dividers()`
gives the dividers; and `has(id)` tells whether `fullscreen(id)` may show `id`,
a card of the grid or a box of the host. Without it the view draws `rects()`,
`rules()` with bleed and `dividers()` of the grid and shows a fullscreen card
across the plane. A host that draws its cards below headers of its own, cuts the
rules at its own boxes or shows a box of several cards fullscreen supplies its own.
`reason` is one of `drag`, `center`, `merge`, `resize`, `render`.

`outline(rects, options)`, `unionLoops(rects)`, `roundedPath(loop, radius)`,
`contains(loops, x, y)`.

## License

MIT

## Random sequence verification

The unit tests and fuzz command share one seeded operation generator and one
transition invariant checker. Ordinary layouts retain minimum-size checks;
fixed layouts also check fixed-size proportions and close predictions;
constrained layouts permit zero-size cards and reduced corridors. Each public
call is checked before the next call, including refused calls. Reports count
successful and refused calls separately from changed and unchanged states,
both in total and per operation. Profile-specific weights retain the original
creation and removal frequencies; ordinary drags retain a separately checked
merge call. A controlled coincident-line fixture proves an accepted merge. A
refused call must leave the state unchanged. Failure reports retain the seed,
initial state and complete operation trace. The independent slicing oracle and
explicit geometry expectations remain separate tests.

A failure can be replayed from its recorded initial state and all layout options,
including snapping distance. Reduction first reproduces that failure, then deletes
operation chunks in a deterministic order. Only the same named invariant accepts
a candidate; passing sequences, different invariants and untagged assertions do
not. The original seed and complete trace remain unchanged beside the reduced
trace. The result is minimal under deletion of one operation, not necessarily the
shortest possible trace, and argument values are not reduced. The fuzz command
prints the complete original before attempting reduction.

Role-independence tests use a separate fixed operation trace. They pass every
permutation of the fixture's card array and renamed identifiers into the public
constructor. Only the comparison normalizes
identifiers and card order. Every operation compares geometry, card attributes,
close/split predictions and its result; controlled identifier-dependent and
array-position-dependent defects must fail that comparison. Source ownership
checks remain structural checks, and the independent slicing oracle remains
separate from both the sequence generator and the role comparison.


## Varied role-independence cases

A bounded selection supplements the fixed five-card test and its 120 input
orders. Seeds 0 through 20 build valid topology through public split operations
before applying the declared options. Each case checks its actual card count,
topology, dimensions and options; generation that collapses into one class fails.
The input classes are:

| Input | Selection |
| --- | --- |
| Topology | columns, rows and mixed cuts |
| Initial cards | 2 through 8; mixed cuts require at least 3 |
| Width / height | 320, 640, 1730 / 180, 900, 1440 px |
| Gap / minimum size | 0, 17, 64 / 24, 96, 160 px |
| Snap | merge and off |
| Snap distance / grab size | 3 and 29 / 7 and 23 px |
| Card attributes | fixed and sharing cards, declared px sizes and zero-size constrained cards |
| Trace | 14 refusal/recovery calls followed by 20 seeded calls |

Each initial array is rotated, reversed and shuffled twice with the case seed;
duplicate orders are removed, and at most the card count plus three orders are
compared with original and renamed identifiers. This selection does not claim
all combinations or all possible layouts. The five-card test still enumerates
all 120 orders separately.

A fixed-card split must refuse, then succeed after clearing the fixed flag and
providing room. A split in a one-pixel plane must refuse, then succeed after
restoring room. Closing the new card proves that work can continue after each
recovery. Every transition reports its successful or refused result, and a
refusal preserves the serialized state and public observations. The report
asserts and lists input classes and per-method outcome counts. Separate controls
prove that gap, minimum size, snapping and grab size change the
corresponding geometry or decisions.

The slicing oracle is a pure test module that imports no layout implementation;
the existing negative pinwheel cases and the varied transition checks use it.
Mutation checks generate and validate inputs with the unchanged implementation,
then replay those same inputs against isolated implementation copies. The
identifier-, array-order- and size-dependent defects leave the existing R2 test
passing and must fail a named assertion on the added narrow-plane case. Loader,
runtime and environment errors do not count as detection. Failures retain the
seed, initial state, options, full call list and selected input orders.
