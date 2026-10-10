// Measures in pixels the center of the window buttons and the center of the first row in one recorded frame (docs/spec/native-surfaces.md#title-bar-height).
// test/titlebar-measurement.test.mjs checks that it rejects frames whose judgement is off and frames that cannot be measured.
import { pixel } from "@soksak/window-check/frame.mjs";

/** The largest distance (px) by which the button center and the first-row center may differ. */
export const TOLERANCE = 0.5;

/** The height (px) of the first row at frame scale factor. It is the same formula as --chrome-row of the page. */
export const rowHeight = (factor) => Math.round(Math.max(40, 36 * factor));

// The row (pt from the top of the window) where the search for buttons starts. The rounded corner of the window is above this row. The title bar is not lower than 32pt, so
// the top of a 14pt button is not above 9pt.
const START = 8;
// The title bar is not higher than 200pt. The lower border of the first row is inside this row.
const LIMIT = 202;
// The first-row background and the lower border (--card and --edge) differ by 18 or more per channel.
const EDGE = 6;
// The window buttons (also the gray buttons of an inactive window) differ from the first-row background by more than this.
const INK = 16;
// The distance (pt) from the right end of the button area to the column where the background color and the lower border are measured. The first row has a 12px margin to the right of the button area.
const GAP = 6;

const differs = (a, b, tolerance) => a.some((value, index) => Math.abs(value - b[index]) > tolerance);

/**
 * In frame frame (the result of readFrame), measures the lower end row of the first row and the vertical center buttons of the window buttons in pt from the top of the window.
 * buttons are the controls of host.window (window coordinates, pt), and only the horizontal position is used.
 *
 * First row: reads the empty column to the right of the button area downward from START, and the place where the first line that differs from the first-row background (the lower border) ends is the
 * lower end of the row. The top of the row is the top of the window, so the center of the row is row / 2.
 * Buttons: in the middle half column of each button, from START to above the border, the center of the first and the last row that differ from the background by more than INK.
 * A vertical column through a circle is symmetric about the center of the circle, so the center is the same even if the button moves sideways.
 *
 * When it cannot measure, it returns the reason and the place as missing. A frame that cannot be measured is not a pass.
 */
export function measureTitlebar(frame, buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) throw new Error("the window reports no button frames");
  const scale = frame.scale * frame.contentScale;
  const left = frame.content.x * frame.scale;
  const top = frame.content.y * frame.scale;
  const px = (x) => Math.floor(left + x * scale);
  const py = (y) => Math.floor(top + y * scale);
  const right = Math.max(...buttons.map((button) => button.x + button.width));
  const column = px(right + GAP);
  const start = py(START);
  const limit = Math.min(frame.height, py(LIMIT));
  if (column >= frame.width || start >= limit) {
    return { time: frame.time, missing: `the frame ${frame.width}x${frame.height} has no column ${right + GAP}pt below ${START}pt` };
  }
  const background = pixel(frame, column, start);
  let y = start;
  while (y < limit && !differs(pixel(frame, column, y), background, EDGE)) y++;
  if (y >= limit) {
    return { time: frame.time, missing: `no first-row edge below ${START}pt in column ${right + GAP}pt (background ${background})` };
  }
  const edge = y;
  const line = pixel(frame, column, edge);
  while (y < limit && !differs(pixel(frame, column, y), line, EDGE)) y++;
  const row = (y - top) / scale;
  const columns = buttons.flatMap((button) => {
    const from = px(button.x + button.width / 4);
    const to = px(button.x + button.width * 3 / 4);
    return Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index);
  });
  let first = -1;
  let last = -1;
  for (let at = start; at < edge; at++) {
    if (columns.some((x) => differs(pixel(frame, x, at), background, INK))) {
      if (first < 0) first = at;
      last = at;
    }
  }
  if (first < 0) return { time: frame.time, row, missing: `no window button above the first-row edge at ${(edge - top) / scale}pt` };
  if (first === start) return { time: frame.time, row, missing: `window button ink reaches the scan start ${START}pt` };
  const centre = ((first - top) + (last - top) + 1) / 2 / scale;
  return { time: frame.time, row, buttons: centre, difference: centre - row / 2 };
}

/** A frame whose button center differs from the first-row center by more than tolerance, or that cannot be measured. */
export function misaligned(measured, tolerance = TOLERANCE) {
  return measured.filter((frame) => frame.missing !== undefined || Math.abs(frame.difference) > tolerance);
}
