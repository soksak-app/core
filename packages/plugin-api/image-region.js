// The image region attached to one element of a surface page.
//
// The host places an image region inside the surface webview, positioned with the viewport margins that this module reports. The
// position and size of the element are followed with ResizeObserver and the window resize and scroll events.

import { regionInsets, observeRegionInsets } from "./document-region.js";

/** The name rule. The host checks with the same rule. */
export const IMAGE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Attaches the image region name to element. port is page.image of the runtime and view is the window of the element.
 * The calls on the returned region run in order after the attachment finishes. It cannot be called after detach.
 */
export function attachImage(port, element, name, sidecar, view = element.ownerDocument.defaultView, options = {}) {
  if (!IMAGE_NAME.test(name)) throw new Error(`invalid image name ${JSON.stringify(name)}`);
  // A failure that does not return to a caller (a placement during observation, an event with no handler) is reported as an error with this function.
  const { report } = options;
  if (typeof report !== "function") throw new TypeError(`image ${name} requires a report for its failures`);
  const listeners = new Map();
  let detached = false;
  let chain = port.attach(name, sidecar);
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
    const handlers = listeners.get(eventType);
    if (!handlers) {
      report(`image ${name}: no handlers for event type ${eventType}`);
      return;
    }
    for (const fn of handlers) fn(event);
  }));

  const placeAt = ({ insets, visible }) => queue(() => port.place(name, insets, visible));
  // default: the thrown value may not be an Error, so without message the value itself is written.
  const failed = (error) => report(`image ${name} place: ${error?.message ?? error}`);
  const stopObserving = options.observe === false ? () => {} : observeRegionInsets(element, view, placeAt, failed);

  return {
    name,
    _ready: chain,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    focus() {
      return queue(() => port.focus(name));
    },
    setCaret(rect) {
      return queue(() => port.caret(name, rect.x, rect.y, rect.width, rect.height));
    },
    setAccessibleText(text) {
      return queue(() => port.text(name, text));
    },
    visible(v) {
      const { insets } = regionInsets(element, view);
      return placeAt({ insets, visible: v });
    },
    _place: placeAt,
    detach() {
      const done = queue(() => port.detach(name));
      detached = true;
      stopObserving();
      listeners.clear();
      unlisten.then((stop) => stop());
      return done;
    },
  };
}
