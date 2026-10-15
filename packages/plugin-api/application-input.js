// The translation of the input of the surface into input messages of the embed protocol (docs/protocol.md of the embed
// kit). Positions are CSS pixels of the view, which are the points of the region.

const BUTTONS = ["left", "middle", "right"];
const CURSORS = {
  default: "default", pointer: "pointer", text: "text", crosshair: "crosshair", move: "move", grab: "grab",
  grabbing: "grabbing", "resize-ew": "ew-resize", "resize-ns": "ns-resize", "resize-nesw": "nesw-resize",
  "resize-nwse": "nwse-resize", "not-allowed": "not-allowed", none: "none",
};
const INPUT_TYPES = new Set(["key", "compose", "commit", "pointer", "scroll", "focus"]);

const modifiers = (event) => ({ shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey });

/** The buttons held in a `buttons` bit mask of a pointer event. */
const held = (mask) => [[1, "left"], [4, "middle"], [2, "right"]].filter(([bit]) => mask & bit).map(([, name]) => name);

/** The embed `pointer` message of a pointer event of the view at `rect`. */
export function pointer(phase, event, rect, input) {
  const message = { type: "pointer", phase, x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (phase !== "move") message.button = BUTTONS[event.button];
  return { ...message, buttons: held(event.buttons), ...modifiers(event), input };
}

/** The embed `scroll` message of a wheel event; a pixel delta comes from a trackpad, a line or page delta from a wheel. */
export function scroll(event, rect, input) {
  return { type: "scroll", x: event.clientX - rect.left, y: event.clientY - rect.top, dx: event.deltaX, dy: event.deltaY,
    precise: event.deltaMode === 0, input };
}

/**
 * The embed messages of an event of the image region. A region reports one `key` per key press without its release or
 * the command key, which the application menu takes, so a press becomes a key down and a key up without meta.
 */
export function region(type, event) {
  if (type === "key") {
    const key = { type: "key", key: event.key, ...(event.text === undefined ? {} : { text: event.text }), shift: event.shift,
      alt: event.alt, ctrl: event.ctrl, meta: false, repeat: false };
    return [{ ...key, down: true }, { ...key, down: false }];
  }
  if (type === "insert") return [{ type: "commit", text: event.text }];
  if (type === "compose") return [{ type: "compose", text: event.text ?? "", caret: event.caret ?? 0 }];
  if (type === "focus") return [{ type: "focus", focused: event.focused }];
  throw new Error(`unknown region event ${type}`);
}

/** The CSS cursor of an embed cursor shape; another shape is an error. */
export function cursor(shape) {
  const css = CURSORS[shape];
  if (css === undefined) throw new Error(`unknown cursor shape ${String(shape)}`);
  return css;
}

/** Throws unless `message` is an embed input message. */
export function checkInput(message) {
  if (!INPUT_TYPES.has(message?.type)) throw new Error(`input: ${String(message?.type)} is not an input message`);
  return message;
}
