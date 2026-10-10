// The document region attached to one element of a surface page. It is the "document region" of docs/spec/native-surfaces.md.
//
// The host places a document webview inside the surface webview, positioned with the viewport margins that this module reports. The
// position and size of the element are followed with ResizeObserver and the window resize and scroll events. A layout in which
// only the position changes while the size of the element or an ancestor does not change shows up as a size change of an ancestor.

/** The name rule. The host checks with the same rule. */
export const DOCUMENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DOCUMENT_ACTIONS = Object.freeze(["back", "forward", "reload", "stop"]);

/**
 * Checks whether the element and its ancestors are hidden by CSS visibility or display.
 * It decides with getComputedStyle, the standard method.
 * It works in the whole supported range (macOS 14.0 and later).
 */
function isElementVisible(element, view) {
  // Follows the ancestor chain from the element and checks visibility and display.
  let el = element;
  while (el && el !== view.document.body.parentElement) {
    const style = view.getComputedStyle(el);
    // The element is not visible when visibility is hidden or display is none.
    if (style.visibility === "hidden" || style.display === "none") {
      return false;
    }
    el = el.parentElement;
  }
  return true;
}

/** The viewport margins of the element. visible is false when the element is not shown. */
export function regionInsets(element, view) {
  const rect = element.getBoundingClientRect();
  const insets = {
    left: rect.left,
    top: rect.top,
    right: view.visualViewport.width - rect.right,
    bottom: view.visualViewport.height - rect.bottom,
  };
  const shown = element.isConnected && rect.width > 0 && rect.height > 0
    && isElementVisible(element, view);
  return { insets, visible: shown };
}

/**
 * Observes the viewport margins of the element and reports changes with onPlace. Returns a cleanup function that stops the observation.
 * onPlace returns an asynchronous operation, and the next placement is sent after that return is fulfilled. A failure of onPlace has no caller to receive it, so it is reported with
 * report(line). The observation starts at the next animation frame (AGENTS.md).
 */
export function observeRegionInsets(element, view, onPlace, report) {
  if (typeof report !== "function") throw new TypeError("observing region insets requires a report for its failures");
  let placed = null;
  let detached = false;
  const place = () => {
    if (detached) return;
    const next = regionInsets(element, view);
    const key = JSON.stringify(next);
    if (key === placed) return;
    placed = key;
    // The observation continues when a placement operation fails. The failure is reported as an error.
    onPlace(next).catch(report);
  };
  const observer = new view.ResizeObserver(place);
  let frame = view.requestAnimationFrame(() => {
    frame = null;
    if (detached) return;
    for (let node = element; node; node = node.parentElement) observer.observe(node);
  });
  view.addEventListener("resize", place);
  view.addEventListener("scroll", place, true);
  place();
  return () => {
    detached = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    observer.disconnect();
    view.removeEventListener("resize", place);
    view.removeEventListener("scroll", place, true);
  };
}

/**
 * Attaches the document region name to element. port is page.document of the runtime and view is the window of the element.
 *
 * The calls on the returned region run in order after the attachment finishes. state is the last
 * document state that the host reported and onState is called each time the state changes. It cannot be called after detach.
 */
export function attachRegion(port, element, name, view = element.ownerDocument.defaultView, options = {}) {
  if (!DOCUMENT_NAME.test(name)) throw new Error(`invalid document name ${JSON.stringify(name)}`);
  // A failure that does not return to a caller (a placement during observation) is reported as an error with this function.
  const { report } = options;
  if (typeof report !== "function") throw new TypeError(`document ${name} requires a report for its failures`);
  const listeners = new Set();
  let state = null;
  let detached = false;
  let chain = port.attach(name);
  const queue = (work) => {
    if (detached) return Promise.reject(new Error(`document ${name} is detached`));
    const next = chain.then(work);
    // The failure is delivered as a rejection to the caller that received next. The chain continues after that failure for the next operation.
    chain = next.then(() => undefined, () => undefined);
    return next;
  };

  const unlisten = Promise.resolve(port.onState((document, value) => {
    if (document !== name || detached) return;
    state = value;
    for (const fn of listeners) fn(value);
  }));
  // The messages of a plugin document of this region (docs/spec/native-surfaces.md#document-regions).
  const messageListeners = new Set();
  const unlistenMessages = Promise.resolve(port.onMessage((document, message) => {
    if (document !== name || detached) return;
    for (const fn of messageListeners) fn(message);
  }));

  const placeAt = ({ insets, visible }) => queue(() => port.place(name, insets, visible));
  // default: the thrown value may not be an Error, so without message the value itself is written.
  const failed = (error) => report(`document ${name} place: ${error?.message ?? error}`);
  const stopObserving = options.observe === false ? () => {} : observeRegionInsets(element, view, placeAt, failed);

  return {
    name,
    _ready: chain,
    get state() { return state; },
    onState(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Reports a placement that the element changed. Used for a move that the observation does not reveal. */
    place: () => {
      const { insets, visible } = regionInsets(element, view);
      return placeAt({ insets, visible });
    },
    _place: placeAt,
    load: (url) => queue(() => port.load(name, url)),
    /** Sends a JSON value to the window of the region's plugin document. */
    post: (message) => queue(() => port.post(name, message)),
    /** Calls fn with each message that the region's plugin document posts to its own window; returns the stop. */
    onMessage(fn) {
      messageListeners.add(fn);
      return () => messageListeners.delete(fn);
    },
    /** Sets the page zoom of the document as a text size scale (docs/spec/text-size.md). */
    zoom: (factor) => queue(() => port.zoom(name, factor)),
    go(action) {
      if (!DOCUMENT_ACTIONS.includes(action)) return Promise.reject(new Error(`unknown document action ${action}`));
      return queue(() => port.go(name, action));
    },
    /** Opens the session history entry offset away from the current entry. offset is a non-zero integer. */
    entry(offset) {
      if (!Number.isInteger(offset) || offset === 0) return Promise.reject(new Error(`invalid history offset ${offset}`));
      return queue(() => port.go(name, "entry", offset));
    },
    back() { return this.go("back"); },
    forward() { return this.go("forward"); },
    reload() { return this.go("reload"); },
    stop() { return this.go("stop"); },
    detach() {
      const done = queue(() => port.detach(name));
      detached = true;
      stopObserving();
      listeners.clear();
      messageListeners.clear();
      unlisten.then((stop) => stop());
      unlistenMessages.then((stop) => stop());
      return done;
    },
  };
}
