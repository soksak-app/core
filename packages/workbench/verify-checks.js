// The parts of the verification computation that do not read the plane or the compositor. verify.js passes the values it read from the plane.
import { isPlace } from "./registry.js";
import { sizeKey, windowSidebarsArranged } from "./window-sidebars.js";

/**
 * The scale that the host seated a visible surface with. The compositor accepts a visible placement only with the scale (validatePlacementAnswer), so a
 * seated surface without it is a defect of the record, which verification refuses with its own error.
 */
export function seatScale(surface) {
  const seat = surface.scale;
  if (!(seat > 0)) throw new Error(`verify: seated surface ${surface.id} has no seat scale (${seat})`);
  return seat;
}

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
/**
 * Whether the window sidebars stand where the order places them (docs/spec/external-sidebars.md#verification): each is fixed, stands at
 * the border line of its side, reaches along the other axis between the sidebars of earlier sides of that axis, and is drawn no larger on
 * its axis than its saved size.
 */
export function windowSidebarsPlaced(grid, order) {
  const places = grid.cards.filter(card => isPlace(card.id));
  const arranged = order.filter(side => places.some(card => card.id === side));
  const extent = card => {
    const key = sizeKey(card.id);
    return card[key] === undefined || (key === "width" ? grid.rect(card.id).w : grid.rect(card.id).h) <= card[key] + .5;
  };
  return places.every(extent) && windowSidebarsArranged(grid, arranged);
}
