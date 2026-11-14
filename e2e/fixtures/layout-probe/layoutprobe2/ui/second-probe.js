// The view of the second layout probe: its surface id, the size and scale of its view, and the text size of its surface with the
// height of its line of text, served as layoutprobe2.surface. The line of text is drawn at 13 points times the text size of the
// surface, as a text size reaches a view (docs/spec/text-size.md), and the empty area below it shows only the card background. The
// module imports nothing: its owner test runs it on the view bridge and the exposure of core.

/** The font size of the line of text at text size 1, in CSS pixels. */
export const TEXT_SIZE = 13;

/**
 * Serves layoutprobe2.surface through expose, exposes the line of text and the empty area, and follows the size of the view and
 * the text size of the surface through bridge.
 */
export async function startSecondProbe({ bridge, expose, view }) {
  const text = view.document.getElementById("text");
  const empty = view.document.getElementById("empty");
  let factor = await bridge.runtime.textSize.read();
  const read = () => {
    text.style.fontSize = `${TEXT_SIZE * factor}px`;
    return {
      surface: view.sokSurface.surface, width: view.innerWidth, height: view.innerHeight, scale: view.devicePixelRatio,
      text: { factor, height: text.getBoundingClientRect().height },
    };
  };
  let value = read();
  const listeners = new Set();
  const changed = () => {
    value = read();
    for (const listener of listeners) listener(value);
  };
  view.addEventListener("resize", changed);
  await expose.status("layoutprobe2.surface", () => value, (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  await expose.element("layoutprobe2.text", text);
  await expose.element("layoutprobe2.empty", empty);
  await bridge.runtime.textSize.on((next) => {
    factor = next;
    changed();
  });
}
