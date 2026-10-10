// The frame text scale and the height of the first row (docs/spec/native-surfaces.md#title-bar-height).
//
// The scale is written to the document in the drawing of the prepared layout, not when the setting changes. The preparation holds the first row height of that drawing, and the host
// sets the window title bar to that height in the same transaction, so the row and the window buttons change in the same frame.

/** The smallest height of the first row (px). It is --chrome-h of app.css. */
const CHROME_H = 40;
/** The row height at scale 1 (px). It is --chrome-row-h of app.css. */
const CHROME_ROW_H = 36;

/** The scale written to the document. Before it is written, it is 1, the :root value of app.css. */
let drawn = 1;

function checked(factor) {
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) {
    throw new Error(`frame text factor ${factor} is not a positive finite number`);
  }
  return factor;
}

/**
 * The height of the first row (px) for factor. It equals round(nearest, max(--chrome-h, --chrome-row-h × factor), 1px), which is --chrome-row of app.css.
 * The round(nearest) of CSS picks the larger side at the middle value, and so does Math.round.
 */
export function chromeRow(factor) {
  return Math.round(Math.max(CHROME_H, CHROME_ROW_H * checked(factor)));
}

/** Writes the scale to the document. At 1, zoom is not declared (app.css). */
function write(factor) {
  const root = document.documentElement;
  root.style.setProperty("--frame-text", String(factor));
  if (factor === 1) delete root.dataset.frameText;
  else root.dataset.frameText = "";
}

/** The drawing writes the scale to the document. */
export function applyFrameText(factor) {
  write(checked(factor));
  drawn = factor;
}

/** The scale written to the document. */
export const drawnFrameText = () => drawn;

/**
 * Reads the document at factor with read and restores the drawn scale. It writes and restores inside the same task, so the document renders
 * nothing in between. It is used to measure the plane size that a new scale gives before the preparation.
 */
export function measureAt(factor, read) {
  checked(factor);
  if (factor === drawn) return read();
  write(factor);
  try {
    return read();
  } finally {
    write(drawn);
  }
}

/**
 * The step of the prepared layout that draws the first row of a window without a plane (drawPrepared of layout-queue.js). The preparation holds the first row height of factor without surfaces,
 * the drawing clears the plane (clearPlane), writes factor, and draws the screen (show), and the presentation is the commit of the drawn row.
 * The switch to the library cancels the drawing of the plane prepared before it, so this layout is drawn with the current scale to avoid losing the scale of the canceled drawing,
 * and the library screen is shown in the same drawing.
 *
 *   publishAhead(rects, seated, titlebar), publish(), frame(work)  functions of compositor.js and layout-queue.js
 */
export function frameLayout({ factor, publishAhead, publish, frame, clearPlane = () => {}, show = () => {} }) {
  const titlebar = chromeRow(factor);
  return {
    prepare: () => publishAhead(new Map(), new Map(), titlebar),
    draw: () => {
      clearPlane();
      applyFrameText(factor);
      show();
    },
    frame,
    presented: publish,
  };
}
