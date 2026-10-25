import { pixel } from "@soksak/window-check/frame.mjs";

// Background of the gap between cards. It is --bg (#101117) of the midnight theme.
const PAGE = [16, 17, 23];

// Measures the background of the fixed sidebar card to the left of the shell card and the rail that joins the shell card to the right fixed sidebar. The horizontal
// span and the measured row of the shell surface are given by at (the shell input divider of outside.mjs). The rail passes the left
// edge of the shell card only in the rows of the shell card, so it is measured in those rows. When a measurement fails, it returns the items that could not be measured and the pixels at their positions as missing.
export function alignment(frame, at) {
  const y = at.row;
  // The head and the rows of a sidebar card differ in color by content, so everything before the gap background starts is taken as the sidebar.
  const page = (x) => pixel(frame, x, y).every((value, i) => Math.abs(value - PAGE[i]) <= 5);
  let x = Math.round(at.card.l - 20 * at.scale);
  if (x < 0 || page(x)) {
    return { missing: `sidebar card left of the gap ${JSON.stringify(PAGE)} at ${x},${y}` + (x < 0 ? "" : `: ${JSON.stringify(pixel(frame, x, y))}`) };
  }
  while (x + 1 < frame.width && !page(x + 1)) x++;
  const sidebar = x;
  let ink = 0, rail = null;
  for (let k = x + 1; k <= x + 20 * at.scale && k < frame.width; k++) {
    const [r, g, b] = pixel(frame, k, y);
    const weight = b - Math.max(r, g);
    if (weight <= 25 || weight <= ink) continue;
    ink = weight;
    rail = k;
  }
  if (!ink) return { missing: `rail ink right of the sidebar edge ${x} at row ${y}` };
  return {
    contentLeft: -at.left,
    contentRight: -at.right,
    sidebar: (at.card.l - sidebar) / at.scale,
    rail: (at.card.l - rail) / at.scale,
  };
}

/** Measures the largest change in same-frame content, card, sidebar and rail offsets, in points. */
export function alignmentDelta(initial, geometry) {
  return Math.max(...Object.keys(initial).map((key) => Math.abs(geometry[key] - initial[key])));
}
