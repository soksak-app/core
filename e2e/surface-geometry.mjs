// WebKit on macOS takes the layout viewport of a root view as its native frame size truncated to whole CSS pixels in
// each dimension (docs/spec/plugin-processes.md), so a 286.5 point frame at scale 2 has a 286 CSS pixel document. The
// surface document matches its native frame when it has that truncated size at the scale of the window.
export function documentMatchesFrame(doc, frame, scale) {
  const width = Math.floor(frame.width), height = Math.floor(frame.height);
  return doc.scale === scale
    && doc.body.width === width && doc.body.height === height
    && doc.viewport.width === width && doc.viewport.height === height;
}

// The WebKit of macOS 15 reports whole CSS pixel pointer coordinates and a later one reports the fractional point. A
// press inside the surface (`inside`: the point `pressed` and the coordinate `reported`) measures the precision of the
// WebKit of the run, and returns the document coordinate that a native press at `value` points reports at that
// precision. A reported coordinate that is neither the point nor its whole pixel is an error.
export function pointerAtPrecision(inside, value) {
  if (Math.abs(inside.reported - inside.pressed) < 0.001) return value;
  if (inside.reported === Math.floor(inside.pressed)) return Math.floor(value);
  throw new Error(`a press at ${inside.pressed} points reported ${inside.reported}, which is neither the point nor its whole pixel`);
}
