// The focused exposed element of each view document and the first responder of the window, which core.focus combines
// (docs/spec/exposure.md#keyboard-focus). A view reports its value with the view call tab.focus, and the host sends the first
// responder as the window event window-responder.

const viewFocus = new Map();
const listeners = new Set();
// default: before the host sends the first responder, and in a runtime without a host, the main page holds the focus.
let responder = { owner: "page", surface: null, document: null };

const changed = () => {
  for (const listener of listeners) listener();
};

/** Registers listener for each change of a view focus or of the first responder; returns the function that removes it. */
export function onFocusSourceChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Records the value of the view call tab.focus of surface: `{name, index}` or null. Any other value is refused. */
export function setViewFocus(surface, value) {
  if (value !== null && (typeof value !== "object" || typeof value.name !== "string" || value.name === ""
      || !Number.isSafeInteger(value.index) || value.index < 0 || Object.keys(value).length !== 2)) {
    throw new TypeError(`view call tab.focus requires {name, index} or null, not ${JSON.stringify(value)}`);
  }
  viewFocus.set(surface, value);
  changed();
}

/** Forgets the focus of a view whose document ended or whose surface closed. */
export function forgetViewFocus(surface) {
  if (viewFocus.delete(surface)) changed();
}

/** Applies a window-responder event `{owner, surface, document}` of the host. Any other value is refused. */
export function setResponder(event) {
  const text = (value) => value === null || (typeof value === "string" && value !== "");
  if (event === null || typeof event !== "object" || typeof event.owner !== "string" || !text(event.surface) || !text(event.document)) {
    throw new TypeError(`invalid window-responder event ${JSON.stringify(event)}`);
  }
  responder = { owner: event.owner, surface: event.surface, document: event.document };
  changed();
}

/** The first responder of the window as the host last reported it. */
export const currentResponder = () => responder;

/** The recorded focus of the view of surface, or null. */
// default: a view that reported no focus has no focused exposed element, which core.focus states as null.
export const viewFocusOf = (surface) => viewFocus.get(surface) ?? null;
