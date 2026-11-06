import { distance } from "./png.mjs";

// A web view host paints through a display surface and its still has a declared colour one level away, so a check allows two levels.
export const EDGE_COLOR_TOLERANCE = 2;

const rgb = (hex) => [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
const name = (color) => color.map((value) => value.toString(16).padStart(2, "0")).join("");

/**
 * The faults of the four edges of a native view in a still. frame is the rectangle that the view declared, in points, and scale the
 * device pixels of a point. At the middle of each edge, the device pixel inside it has the colour view, as a band of another colour
 * means the view does not paint its slot, and the device pixel outside it has one of the colours lines, as anything else means a row
 * of the card or the window lies between the view and the line of its card. Geometry alone does not state this: a view can stand exactly
 * where it declared and still leave such a row. An empty list holds no fault.
 */
export function viewEdgeFaults(image, frame, scale, { view, lines }) {
  const left = Math.round(frame.x * scale), right = Math.round((frame.x + frame.w) * scale);
  const top = Math.round(frame.y * scale), bottom = Math.round((frame.y + frame.h) * scale);
  const row = Math.floor((top + bottom) / 2), column = Math.floor((left + right) / 2);
  const faults = [];
  for (const [edge, inside, outside] of [
    ["left", [left, row], [left - 1, row]],
    ["right", [right - 1, row], [right, row]],
    ["top", [column, top], [column, top - 1]],
    ["bottom", [column, bottom - 1], [column, bottom]],
  ]) {
    const within = image.pixel(...inside), beyond = image.pixel(...outside);
    if (distance(within, rgb(view)) > EDGE_COLOR_TOLERANCE) faults.push(`${edge}: the pixel ${inside} inside the view is ${name(within)}, not ${view}`);
    if (!lines.some((line) => distance(beyond, rgb(line)) <= EDGE_COLOR_TOLERANCE)) {
      faults.push(`${edge}: the pixel ${outside} outside the view is ${name(beyond)}, not one of ${lines.join(", ")}`);
    }
  }
  return faults;
}
