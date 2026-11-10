// The image region of a surface composition. The host places it with the composition of the surface, so this module only attaches the
// region and forwards its operations and events.

/** The name rule. The host checks with the same rule. */
export const IMAGE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Attaches the image region name of the composition of a surface. port is page.image of the runtime. The host places the region
 * with the composition, so the region observes no element and sends no placement of its own (docs/spec/plugins.md#view-surfaces).
 * The calls on the returned region run in order after the attachment finishes. It cannot be called after detach.
 */
export function attachImage(port, element, name, sidecar, options = {}) {
  if (!IMAGE_NAME.test(name)) throw new Error(`invalid image name ${JSON.stringify(name)}`);
  // A failure that does not return to a caller (a placement during observation, an event with no handler) is reported as an error with this function.
  const { report, input } = options;
  if (typeof report !== "function") throw new TypeError(`image ${name} requires a report for its failures`);
  if (input !== undefined && typeof input !== "function") throw new TypeError(`image ${name} input must be a function`);
  const listeners = new Map();
  // The input handler given at the creation receives each input event in its dispatch, from the attachment. Without it, the input
  // transactions before the first input handler wait in order: a region takes the first responder as soon as it shows, which can come
  // before the module of the surface registers its handler, and input of the user is not lost (docs/spec/native-surfaces.md#image-regions).
  // That form is the one of the installed terminal plugin and goes when it gives input at the creation.
  let heldInput = [];
  let detached = false;
  let chain = port.attach(name, sidecar);
  // The host holds the caret of the region relative to the region, so a caret equal to the last accepted one changes nothing.
  let lastCaret = null;
  let lastCaretWork = null;
  const queue = (work) => {
    if (detached) return Promise.reject(new Error(`image ${name} is detached`));
    const next = chain.then(work);
    // The failure is delivered as a rejection to the caller that received next. The chain continues after that failure for the next operation.
    chain = next.then(() => undefined, () => undefined);
    return next;
  };

  const unlisten = Promise.resolve(port.on((imageName, event) => {
    if (imageName !== name || detached) return;
    const eventType = typeof event === "string" ? event : event?.type;
    // An event with no handler is not discarded but reported as an error.
    if (!eventType) {
      report(`image ${name}: event has no type: ${JSON.stringify(event)}`);
      return;
    }
    if (eventType === "input" && input) {
      input(event);
      return;
    }
    const handlers = listeners.get(eventType);
    if (eventType === "input" && (!handlers || heldInput.length > 0)) {
      heldInput.push(event);
      return;
    }
    if (!handlers) {
      report(`image ${name}: no handlers for event type ${eventType}`);
      return;
    }
    for (const fn of handlers) fn(event);
  }));

  return {
    name,
    _ready: chain,
    on(type, fn) {
      if (type === "input" && input) throw new Error(`image ${name}: the input handler is the input of composition.create`);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      // The registration ends first, so the module finishes its setup before its handler runs.
      if (type === "input" && heldInput.length > 0) {
        queueMicrotask(() => {
          const events = heldInput;
          heldInput = [];
          for (const event of events) for (const handler of listeners.get("input")) handler(event);
        });
      }
      return () => listeners.get(type).delete(fn);
    },
    focus() {
      return queue(() => port.focus(name));
    },
    setCaret(rect) {
      const key = JSON.stringify([rect.x, rect.y, rect.width, rect.height]);
      if (!detached && key === lastCaret) return lastCaretWork;
      const work = queue(() => port.caret(name, rect.x, rect.y, rect.width, rect.height));
      lastCaret = key;
      lastCaretWork = work;
      // A refused caret is sent again by the next call with the same value.
      work.catch(() => {
        if (lastCaretWork === work) lastCaret = null;
      });
      return work;
    },
    setAccessibleText(text) {
      return queue(() => port.text(name, text));
    },
    detach() {
      const done = queue(() => port.detach(name));
      detached = true;
      if (heldInput.length > 0) report(`image ${name}: no handlers for event type input (${heldInput.length} held until the detach)`);
      heldInput = [];
      listeners.clear();
      unlisten.then((stop) => stop());
      return done;
    },
  };
}
