// The page module of a view that uses the bare globals of a browser page (document, addEventListener, Element, KeyboardEvent,
// MouseEvent, requestAnimationFrame) without a window prefix, as a plugin page does. The module keeps each key that its listener receives.
export const keys = [];

/** Mounts the page on the bare globals and reports what each global is. */
export function mount() {
  const root = document.createElement("div");
  root.id = "page-root";
  document.body.append(root);
  addEventListener("keydown", (event) => keys.push(event.key));
  return {
    rootIsElement: root instanceof Element,
    isWindowDocument: document === window.document,
    keyboardEvent: new KeyboardEvent("keydown", { key: "b" }) instanceof window.KeyboardEvent,
    mouseEvent: new MouseEvent("click") instanceof window.MouseEvent,
    frame: typeof requestAnimationFrame,
  };
}
