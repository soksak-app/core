# Sizes of the layout operations

[한국어](layout-sizes.ko.md)

This proposal states one rule of sizes for every operation that changes the layout of a plane. It is pending: the choice between it and the current rules of [groups](../spec/groups.md) is open, and no workbench implements it. The layout library implements its two primitives ([add and remove](../../packages/soksak/docs/layout.md#add-and-remove)), whose examples `docs/spec/cases/layout/grid.json` states and whose invariants `docs/spec/cases/layout/invariants.json` checks; a balance that gives every level equal shares and the refusal that names the size of a card hold under every candidate and are part of the current contract.

## Model

- The stored layout of a plane is its canonical slicing tree; the rectangles are derived from the tree, and the tree is never rebuilt from the rectangles. A level has an axis, a row or a column, and children whose fractions sum to 1; a level never has a child level of the same axis.
- A leaf is a content card or a group card; a group card holds a plane of its own.
- A fixed leaf, a window sidebar, keeps its size in points; shares, evenness and payment count only the other children of a level.
- A level is even when its children that are not fixed have equal fractions.

## Two primitives

- REMOVE(X): X leaves its level, and the siblings that are not fixed scale by one factor to fill the level, so their ratios hold. A level left with one child is replaced by that child. A group left with one card is replaced by that card when the operation commits, after its target is resolved. The last content card of the root plane is not removed.
- ADD(M, N, side), with N a leaf, a run of contiguous siblings of one level, a level or the root of a plane, and `a` the axis of side:
  - Along: the level that holds N, or N itself when N is a level of axis `a` and side is its end, has axis `a`, and M is inserted beside N toward side. On an even level M gets 1/(k+1) of the level and every child keeps its ratio, so the level stays even. On a level that is not even only N pays: M gets half of N and every other child keeps its size.
  - Across: N is wrapped in a new level of axis `a` that holds N and M toward side, each 1/2.
  - Refusal: the operation is refused when a node whose rectangle changes would fall below its minimum, computed recursively with headers and gaps as fixed costs ([minimum size](../spec/groups.md#minimum-size)); the error names that node, the size it needs and the size it would have.

## Every operation is a composition

| Operation | Definition |
| --- | --- |
| split button, `core.layout.open {side}` on card X | ADD(new, X, side) |
| group split button on card X toward side | X and the new card go into a group card that takes the place and the size of X; the plane of the group is ADD(new, X, side) |
| drop on a side zone of card X | ADD(moving, X, side) |
| drop on a line segment between the siblings i and i+1 of one level | ADD(moving, sibling i, the side toward i+1) |
| drop on a span of contiguous siblings of one level | ADD(moving, run, side) |
| drop on an edge of a plane or of the plane of a group | ADD(moving, root of that plane, side) |
| drop on a group header, or on the tabs of a group | ADD(moving, root of the plane of the group, right) |
| tab onto the centre or the tab strip of card X | the tab joins X at the index; a source card left without tabs is REMOVEd |
| card onto the tab strip of card X | every tab of the card joins X at the index; the card is REMOVEd |
| card onto the centre of card X | the two leaves exchange places, and each place keeps its size |
| close of a card, of the tab of a card with one tab, of a group | REMOVE |
| move of the tab of a card with one tab, of a card or of a group | REMOVE(moving), then the ADD of the target, committed as one change |
| balance | every level becomes even |
| boundary drag | changes the two fractions beside the boundary only |
| fullscreen | a fullscreen card or group refuses layout changes; a tab drag restores the arrangement first |

## Target search

- Hit areas are drawn on the current layout, and the result is computed on the tree after REMOVE(moving).
- Each segment of a line belongs to one level of the tree; a line that runs on across levels is separate segments with separate previews. The face of a line segment is the side of the pointer.
- A target that names the moving node or its vacated place maps to the vacated slot (level, index, fraction), whose ADD is the inverse of the REMOVE, so a drop back is no change.
- Nested sides that share one screen line get bands ordered by depth from the outside in, whatever the gap; targets whose results are equal are one band. The bands of a card have their standard width in points while the card holds them all; otherwise every band of that card narrows by one factor, so that they end short of the centre of the card. A side is chosen by the distance of the point from it divided by the distance that side has, because a fixed band width cannot keep every side reachable (I4) in a card of the minimum size.
- A run is chosen by the point where the drag entered the line and the current point.
- No target is excluded because the pointer is over the dragged card: a drop is no change exactly when its result equals the current layout. Both workbenches now resolve a drop of the only tab of a card over that card as its centre, which leaves the full-width side of the plane below a card that stood under another unreachable.

## Invariants

These are checked over generated layouts, every anchor and every point:

- I1 tiling: the cards cover the plane without gap or overlap.
- I2 minimum: no changed node is below its recursive minimum; otherwise the operation is refused and names it.
- I3 preview equals result for every anchor and point.
- I4 reachability: every (node, side) of the current tree, every vacated slot, every centre and every strip index has an anchor and a point that select it, after equal results are merged.
- I5 moves keep every tab and surface.
- I6 a drop is no change exactly when its result equals the current layout.
- I7 ratios: ADD and REMOVE keep the ratios of the fractions of every sibling that they do not insert, remove or, on a level that is not even, halve; an even level, whose kids that take a fraction have one fraction, stays even under an ADD or a REMOVE inside it.
- I8 locality: the rectangles outside the subtrees of the source and the target levels, after the canonical merge, do not change.
- I9 commands are idempotent with the identifiers they return.
- I10 inverse: the REMOVE of a node just added restores the fractions of an even level, and a drop of a moved node on its vacated slot is no change.

## Objections and answers

- Objection: a rule that reads the tree from the rectangles changes its result when lines align by chance. Answer: the stored layout is the canonical tree, and the rectangles are derived from it. Both workbenches today store lines and rebuild the tree from them for each operation.
- Objection: an even level that stays even under every operation cannot be stated as one invariant over all layouts. Answer: I7 states the ratios that each primitive keeps; evenness follows from it on an even level, and I10 states the inverse.
- Objection: a group with one card cannot hold a drop target while a move passes through it. Answer: a group contracts when the operation commits, after the target is resolved.
- Objection: a minimum per card misses headers and gaps of nested groups. Answer: the minimum is computed recursively, with headers and gaps as fixed costs, and the refusal names the node.
- Objection: an equal share for a drop on a card that the person sized unequally undoes that sizing. Answer: on a level that is not even only the target pays half; split buttons and agent opens on an even level insert with an equal share, because repeated splits stay even.
- Objection: a target computed on the tree after the removal moves under the pointer. Answer: hit areas are drawn on the current layout; only the result is computed after the removal, and the vacated slot is a target.
- Objection: nested sides on one screen line cannot be told apart. Answer: they get bands of a minimum width ordered by depth, and equal results share one band.
- Objection: a drop on a group header needs a side. Answer: it adds to the right end of the root of the plane of the group, the side of `core.card.move` `centre` of a group.
- Objection: an edge drop could give the new card the size of the zone that the preview shows. Answer: M always gets an equal share of the level it lands in; a new level of two gives 1/2, so the edges follow the same rule as every other add.
- Objection: changes outside the source and target levels cannot be ruled out when a level contracts. Answer: I8 states locality after the canonical merge.
- Objection: I7 and I10 can be judged on the drawn sizes, as I1 and I2 are. Answer: a drawn ratio is not the stored ratio, because a cut takes its fixed costs (the corridors between its kids, the px sizes and the frames and heads of its boxes) before it gives its kids their fractions, and those costs change with the gap, the heads and the kids around a node; a criterion on drawn ratios therefore failed layouts whose fractions were exact and passed only layouts that rewrote fractions to undo the costs. Each rule works on fractions, each kid is drawn its fraction of what the costs leave, so kids of one fraction are drawn at one size, and a gap change keeps every fraction. I7 and I10 are judged on the fractions of the stored tree; I1 and I2 stay on the drawn rectangles.
