// The chrome metrics: every length, ratio and duration that the stylesheets of the workbench read. workbench.json declares them, and the
// page sets them as custom properties of the document root, so a stylesheet holds no literal of its own (docs/spec/settings.md#values).

import declaration from "./workbench.json" with { type: "json" };

/** The chrome metrics of workbench.json: a custom property name without the leading dashes and its CSS value. */
export const CHROME = declaration.chrome;

/** The rule of background.js, which runs in every web document and reads no module, so a test holds that script to this value. */
export const backgroundBlurRule = `:root { filter: blur(${CHROME["scrim-blur"]}) !important }`;

/** Draws the logo, the one declaration of both workbenches, in the logo element of the chrome bar. */
export function installBrandLogo(element) {
  element.setAttribute("viewBox", CHROME["brand-logo-box"]);
  element.innerHTML = declaration.icons["brand-logo"];
}

/** The sizes of the grip of a divider, for the stylesheet of the plane. */
export const gripMetrics = () => ({ gripThickness: parseFloat(CHROME["sp-grip-thickness"]), gripLength: parseFloat(CHROME["sp-grip-length"]) });

/** Sets every chrome metric on root as the custom property --<name>. */
export function installChromeMetrics(root) {
  for (const [name, value] of Object.entries(CHROME)) root.style.setProperty(`--${name}`, value);
}

/** The media condition of the narrow library: the window is at most the chrome metric library-narrow-w wide. */
export const libraryNarrowCondition = () => `(max-width: ${CHROME["library-narrow-w"]})`;

/** Marks root with data-library-narrow while narrow is true, and removes the mark while it is false. */
export function markLibraryNarrow(root, narrow) {
  if (narrow) root.dataset.libraryNarrow = "";
  else delete root.dataset.libraryNarrow;
}

/**
 * Marks root with data-library-narrow while the window is at most the chrome metric library-narrow-w wide, and keeps the mark current. A media
 * condition cannot read a custom property, so library.css reads this mark.
 */
export function followLibraryWidth(root, view) {
  const narrow = view.matchMedia(libraryNarrowCondition());
  const mark = () => markLibraryNarrow(root, narrow.matches);
  mark();
  narrow.addEventListener("change", mark);
}

/**
 * The box of the focus mark around slot in the coordinates of host, outside the slot on every side by the chrome metric focus-mark-t:
 * the CSS lengths left, top, width and height. hostRect and slotRect are the rectangles of the host and of the slot.
 */
export function focusMarkBox(hostRect, slotRect) {
  const out = parseFloat(CHROME["focus-mark-t"]);
  return {
    left: `${slotRect.left - hostRect.left - out}px`,
    top: `${slotRect.top - hostRect.top - out}px`,
    width: `${slotRect.width + out * 2}px`,
    height: `${slotRect.height + out * 2}px`,
  };
}

/**
 * Places mark around slot in the coordinates of host, outside the slot on every side by the chrome metric focus-mark-t. The stroke of the
 * mark is that metric thick (app.css), so the stroke lies outside the slot and does not cover the surface drawn in it.
 */
export function placeFocusMark(mark, host, slot) {
  Object.assign(mark.style, focusMarkBox(host.getBoundingClientRect(), slot.getBoundingClientRect()));
}
