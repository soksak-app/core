// The view of the second layout probe: its surface id and the size and scale of its view, served as layoutprobe2.surface. The
// module imports nothing, so the owner test runs it with a fake exposure.

/** Serves layoutprobe2.surface through expose and follows the size of the view. */
export async function startSecondProbe({ expose, view }) {
  const read = () => ({ surface: view.sokSurface.surface, width: view.innerWidth, height: view.innerHeight, scale: view.devicePixelRatio });
  let value = read();
  const listeners = new Set();
  view.addEventListener("resize", () => {
    value = read();
    for (const listener of listeners) listener(value);
  });
  await expose.status("layoutprobe2.surface", () => value, (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
}
