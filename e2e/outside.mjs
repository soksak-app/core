// Measures within one frame whether a surface was drawn outside its card.
//
// There is one rule: a native surface is drawn only where its card is drawn. The plane tells the host the position of the surface
// before it draws, the host moves the view to that position, and the drawing of the page
// and the move of the view are carried by their own frames in different composition layers. If the two layers are
// one frame apart, the surface is drawn where the card has not arrived yet, and the size of the offset is
// the distance that the boundary moved in one step.
//
// The numbers inside the commit do not show it. The position that the page declared and the position that the host placed are
// exactly equal, and the drawn element and the declared position are exactly equal. What differs is the time at which both
// are carried to the screen, so it is measured only in composed pixels.
//
// The card is read in the head row, which the surface does not reach. The head is a row that the document draws, so the card
// in that row is at the position where the page draws it now. The surface is read as the horizontal
// span that its own background color occupies. Both come from one frame, so no clock interferes.
// The default background of a terminal surface has the same color as the card (--card), so the background does not separate it from the card. The check changes the default background of the terminal with OSC 11
// to the measurement color (MEASURED_BACKGROUND of terminal-screen.mjs). The horizontal span of that color is the horizontal span of
// the terminal raster composed into that frame.
import { pixel } from "@soksak/window-check/frame.mjs";
import { MEASURED_BACKGROUND, readScreenUntil, setMeasuredBackground } from "./terminal-screen.mjs";

/** The background of a card. The head and the foot have this color. The --card of the midnight theme (#191b24). */
const CARD = [25, 27, 36];
/** The background of the plane. The lane between cards has this color. The --bg of the midnight theme (#101117). */
const PLANE = [16, 17, 23];
/** The border of a card: normally (--edge #2b2e3d) and when it has the focus (--focus #ffb36b). */
const BORDERS = [[43, 46, 61], [255, 179, 107]];

/** The shortest horizontal span (px) that counts as a raster row. The background between the strokes of a glyph does not continue this far. */
const LINE = 40;

/** A color that deviates by more than this is not that color. */
const NEAR = 5;


const near = (p, q) => p.every((v, i) => Math.abs(v - q[i]) <= NEAR);
const any = (p, list) => list.some((q) => near(p, q));

/**
 * Walks the rows from from toward to (to is excluded) and returns the first row where colour continues for at least LINE, with the longest
 * span of colour in that row. While the size changes, the terminal shows the raster of the previous size attached to one side, so the function does not read a fixed column.
 * The empty row below the prompt has the background over the whole width of the raster, so the caller walks upward from the bottom edge of the surface. Coordinates are pixels.
 */
export function rasterRow(f, colour, { from, to }) {
  const step = to >= from ? 1 : -1;
  for (let y = from; step > 0 ? y < Math.min(to, f.height) : y > Math.max(to, -1); y += step) {
    if (y < 0 || y >= f.height) continue;
    let best = null;
    for (let x = 0; x < f.width; x++) {
      if (!near(pixel(f, x, y), colour)) continue;
      const l = x;
      while (x + 1 < f.width && near(pixel(f, x + 1, y), colour)) x++;
      if (!best || x - l > best.r - best.l) best = { y, l, r: x };
    }
    if (best && best.r - best.l + 1 >= LINE) return best;
  }
  return null;
}

/**
 * The reference to find the surface of a terminal card. It is read from the declared position of the surface (host.window). head is
 * one row of the card head directly above the surface, top and bottom are the top and the bottom of the surface, and cx is the column 24pt inside the right edge of the surface. All are in points.
 * The check drags the left or the bottom boundary of the terminal card, so the head row, the top of the surface and the right edge do not move.
 * If measured is set, the function changes the default background of the terminal to MEASURED_BACKGROUND after the prompt appears.
 */
export async function terminalMarks(s, { measured = false } = {}) {
  const card = (await s.get("core.grid")).cards.find((item) => item.id === "terminal");
  if (!card?.active) throw new Error("the fixture has no terminal card with an active surface");
  if (measured) {
    await readScreenUntil(s, card.active, (lines) => lines.some((line) => line.includes("$")),
      `${card.active} did not show a shell prompt`);
    await setMeasuredBackground(s, card.active);
    await s.presented();
  }
  const surface = (await s.get("host.window")).surfaces.find((item) => item.id === card.active);
  if (!surface?.frame?.width) throw new Error(`the terminal surface ${card.active} has no declared frame`);
  const { x, y, width, height } = surface.frame;
  return { head: y - 2, top: y, bottom: y + height, cx: x + width - 24, colour: MEASURED_BACKGROUND };
}

/**
 * The head row above the surface. It is the first row where the background color of the card continues for three lines.
 *
 * The content of the surface can have a color close to the card, so one line does not decide it.
 */
function headRow(f, run) {
  const cx = Math.round((run.l + run.r) / 2);
  for (let y = run.y; y >= 2; y--) {
    if (near(pixel(f, cx, y), CARD)
      && near(pixel(f, cx, y - 1), CARD)
      && near(pixel(f, cx, y - 2), CARD)) return y - 1;
  }
  return null;
}

/** The span that holds cx and is not a lane. It is the outer side of one card. */
function span(f, y, cx) {
  const px = (x) => pixel(f, x, y);
  if (near(px(cx), PLANE)) return null;
  let l = cx, r = cx;
  while (l > 0 && !near(px(l - 1), PLANE)) l--;
  while (r < f.width - 1 && !near(px(r + 1), PLANE)) r++;
  return { l, r, w: r - l + 1 };
}

/**
 * How many pixels one point is. The border of a card is --bw and that value is 1 point, so the width of the border
 * is that scale. There is no need to note whether the frame was recorded in points
 * or in pixels.
 */
function perPoint(f, y, card) {
  const px = (x) => pixel(f, x, y);
  let n = 0;
  for (let k = 0; k < 6 && card.l + k < f.width; k++) {
    if (!any(px(card.l + k), BORDERS)) break;
    n++;
  }
  return n > 0 ? n : 1;
}

/**
 * The distance by which the surface went outside its card in this frame, in points.
 *
 * It is compared with the outer rectangle of the card. If the document of the surface draws its background inset, this
 * value comes out smaller by that amount, so an error never goes in the direction of saying that it went outside.
 *
 * A frame that cannot be measured gives null: the surface is not in this frame, the head is not visible, or
 * the card cannot be read in that frame.
 */
export function outside(f, marks) {
  const px = (value) => Math.round(value * f.scale);
  const run = rasterRow(f, marks.colour, { from: px(marks.bottom) - 2, to: px(marks.top) });
  if (!run) return null;
  const y = px(marks.head);
  const cx = Math.round((run.l + run.r) / 2);
  const card = span(f, y, cx);
  if (!card || card.w < 40) return null;
  const scale = perPoint(f, y, card);
  const left = (card.l - run.l) / scale;
  const right = (run.r - card.r) / scale;
  // The neighbor card on the side where the surface went outside. It is the first span met across the lane. The width of the lane is
  // set by the theme, so the function finds it by walking.
  const across = (from, dir) => {
    for (let k = 1; k <= 60; k++) {
      const at = from + dir * k;
      if (at < 1 || at >= f.width - 1) return null;
      if (!near(pixel(f, at, y), PLANE)) return span(f, y, at);
    }
    return null;
  };
  let neighbour = null;
  if (left > 0) neighbour = across(card.l, -1);
  else if (right > 0) neighbour = across(card.r, 1);
  const onNeighbour = neighbour
    ? Math.max(0, Math.min(run.r, neighbour.r) - Math.max(run.l, neighbour.l) + 1) / scale
    : 0;
  return {
    out: Math.max(0, left, right),
    left, right, onNeighbour, scale,
    card: { l: card.l, r: card.r },
    surface: { l: run.l, r: run.r },
    row: y,
  };
}

// Finds each surface of the same background separately. It selects a span that has at least 12 rows of constant width,
// so a small hole in the text is not treated as a rectangle.
export function surfaceBoxes(f, colour, { expectedRow, rowTolerance = 40 } = {}) {
  const runs = new Map();
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      if (!near(pixel(f, x, y), colour)) continue;
      const l = x;
      while (x < f.width && near(pixel(f, x, y), colour)) x++;
      if (x - l < 20) continue;
      const key = `${l}:${x}`;
      const held = runs.get(key);
      if (held) { held.b = y + 1; held.rows++; }
      else runs.set(key, { l, r: x, t: y, b: y + 1, rows: 1 });
    }
  }
  const candidates = [...runs.values()].filter((r) => r.rows >= 12)
    .sort((a, b) => (b.r - b.l) * b.rows - (a.r - a.l) * a.rows);
  const boxes = [];
  for (const r of candidates) {
    // Other rows that use the same background color, such as a browser document, are outside the
    // terminal row measurement range that the caller declared. Candidates inside the range are still verified, and the failure is not hidden.
    if (boxes.some((b) => r.l < b.r && r.r > b.l && r.t < b.b && r.b > b.t)) continue;
    const row = headRow(f, { ...r, y: r.t });
    if (row === null) throw new Error(`content at ${r.l},${r.t} has no DOM header`);
    // Text can cover the first rows of the terminal, so the first row of continuous background is
    // not the top edge of the terminal. Instead, the function filters by the measured card header, which is stable
    // over the whole surface.
    if (expectedRow !== undefined && Math.abs(row / f.scale - expectedRow) > rowTolerance) continue;
    const card = span(f, row, Math.floor((r.l + r.r) / 2));
    if (!card) throw new Error(`content at ${r.l},${r.t} has no DOM card`);
    const sameCard = boxes.find((b) => b.card.l === card.l && b.card.r === card.r && b.row === row);
    if (sameCard) {
      sameCard.l = Math.min(sameCard.l, r.l);
      sameCard.r = Math.max(sameCard.r, r.r);
      sameCard.t = Math.min(sameCard.t, r.t);
      sameCard.b = Math.max(sameCard.b, r.b);
    } else boxes.push({ ...r, card, row });
  }
  return boxes.sort((a, b) => a.t - b.t || a.l - b.l);
}

// Counts all white pixels of the given area. It does not tolerate a small defect by an area ratio.
export function whitePixels(frame, { l, r, t, b }) {
  if (!(l >= 0 && t >= 0 && r <= frame.width && b <= frame.height && r > l && b > t)) {
    throw new Error("invalid pixel measurement rectangle");
  }
  let count = 0;
  for (let y = t; y < b; y++) {
    for (let x = l; x < r; x++) {
      if (pixel(frame, x, y).every((v) => v >= 245)) count++;
    }
  }
  return count;
}

// Reads the bounds and the area of the bright pixels of one glyph. It separates a position move from a change of the glyph size.
export function glyphShape(frame, { l, r, t, b }) {
  let left = r, right = l, top = b, bottom = t, count = 0;
  for (let y = t; y < b; y++) for (let x = l; x < r; x++) {
    if (!pixel(frame, x, y).every((v) => v > 100)) continue;
    count++;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (!count) throw new Error(`no glyph pixels in ${l},${t}..${r},${b}`);
  return { width: right-left+1, height: bottom-top+1, count };
}
