// The parts of the verification computation that do not read the plane or the compositor. verify.js passes the values it read from the plane.
import { isPlace } from "./registry.js";
import { windowSidebar } from "./window-sidebars.js";

/**
 * Adds up the number of connected rectangle clusters of each rail group and returns the number of closed loops that the rail outline must have.
 * Two rectangles are connected when both their horizontal and vertical gaps are at most gap (+0.5).
 */
export function expectedRailLoops(groups, gap) {
  let loops = 0;
  for (const group of groups) {
    const pending = new Set(group.rects.map((_,index) => index));
    while (pending.size) {
      loops++;
      const work = [pending.values().next().value];
      pending.delete(work[0]);
      while (work.length) {
        const a = group.rects[work.pop()];
        for (const index of [...pending]) {
          const b = group.rects[index];
          const dx = Math.max(b.x-(a.x+a.w),a.x-(b.x+b.w));
          const dy = Math.max(b.y-(a.y+a.h),a.y-(b.y+b.h));
          if (dx <= gap+.5 && dy <= gap+.5) { pending.delete(index); work.push(index); }
        }
      }
    }
  }
  return loops;
}

/**
 * Verifies the placement and the width of the window sidebars. It measures the drawn width, not the declared value. The declared value is a request, and the subject of verification is the result.
 * Each side has one sidebar, which stands in the edge column of that side at full height and does not exceed the stored width.
 */
export function windowSidebarsPlaced(grid) {
  const places = grid.cards.filter(card => isPlace(card.id));
  const extent = card => card.width === undefined || grid.rect(card.id).w <= card.width + .5;
  const fullHeight = card => card.fixed && card.r0 === 0 && card.r1 === grid.lines("y").length-1;
  let placeOk = places.every(card => extent(card) && fullHeight(card));
  for (const side of ["left", "right"]) {
    const cardsOnSide = places.filter(card => windowSidebar(card.id).side === side).sort((a,b) => a.c0-b.c0);
    if (!cardsOnSide.length) continue;
    placeOk &&= cardsOnSide.length === 1;
    placeOk &&= side === "left" ? cardsOnSide[0].c0 === 0 : cardsOnSide.at(-1).c1 === grid.lines("x").length-1;
    placeOk &&= cardsOnSide.every((card,index) => index === 0 || cardsOnSide[index-1].c1 === card.c0);
  }
  return placeOk;
}
