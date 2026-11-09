// The device pixel grid of the window (docs/spec/native-surfaces.md). The host seats native surfaces on this grid, so the page
// puts the plane, card edges, dividers and prepared surface rectangles on the same grid. gridScale is the one source of the
// scale of that grid for the page.

/** The number of device pixels per CSS pixel of the grid. */
export const gridScale = () => globalThis.devicePixelRatio;

/** The tolerance of a coordinate that lies on a grid line but reads a little off it after floating point arithmetic. */
const ON_LINE = 1e-6;

/** The sides of the plane, in the order of the CSS padding shorthand. */
const SIDES = Object.freeze(["top", "right", "bottom", "left"]);

/**
 * The insets that move the edges of box inward onto the grid of scale: the top and left edges to the next grid line, the
 * bottom and right edges to the previous one. box is a rectangle in CSS pixels of the viewport, which the window shows at its
 * origin, so the grid lines of the viewport are those of the window.
 */
export function gridInsets(box, scale) {
  if (![box.top, box.right, box.bottom, box.left].every(Number.isFinite) || !(scale > 0)) {
    throw new Error(`invalid plane box ${JSON.stringify(box)} or device pixel ratio ${scale}`);
  }
  const start = (edge) => Math.max(0, Math.ceil(edge * scale - ON_LINE) / scale - edge);
  const end = (edge) => Math.max(0, edge - Math.floor(edge * scale + ON_LINE) / scale);
  return { top: start(box.top), right: end(box.right), bottom: end(box.bottom), left: start(box.left) };
}

/** The inset of side that the stage of the plane holds now, in CSS pixels. */
function heldInset(stage, side) {
  const text = stage.style.getPropertyValue(`--plane-grid-${side}`);
  // default: a stage that was never aligned holds no inset; app.css declares 0px for it.
  if (text === "") return 0;
  const inset = parseFloat(text);
  if (!Number.isFinite(inset)) throw new Error(`the stage holds the plane inset ${side} ${text}`);
  return inset;
}

/**
 * Aligns the origin and the size of the plane inward to the device pixel grid. It is the one place that puts the plane on the
 * grid: whatever lies above or left of the stage (rows, a shown error, a scaled chrome) leaves the plane between grid lines, and
 * the stage takes the remainder as an inset beside its padding (--plane-grid-* of app.css).
 */
export function alignPlane(plane, scale = gridScale()) {
  const stage = plane.parentElement;
  const rect = plane.getBoundingClientRect();
  const held = Object.fromEntries(SIDES.map((side) => [side, heldInset(stage, side)]));
  const box = { top: rect.top - held.top, right: rect.right + held.right, bottom: rect.bottom + held.bottom, left: rect.left - held.left };
  const insets = gridInsets(box, scale);
  for (const side of SIDES) stage.style.setProperty(`--plane-grid-${side}`, `${insets[side]}px`);
}

/**
 * Keeps the plane on the grid. The stage changes size whenever something above or left of it changes, and a change of the
 * display changes the scale. The observer must be created before the view of the plane creates its own, so that the plane
 * is aligned before the view reads its size in the same round.
 */
export function observePlaneGrid(plane) {
  const view = plane.ownerDocument.defaultView;
  new view.ResizeObserver(() => alignPlane(plane)).observe(plane.parentElement);
  let resolution = null;
  const watch = () => {
    resolution?.removeEventListener("change", changed);
    resolution = view.matchMedia(`(resolution: ${gridScale()}dppx)`);
    resolution.addEventListener("change", changed);
  };
  function changed() {
    watch();
    alignPlane(plane);
  }
  watch();
  alignPlane(plane);
}
