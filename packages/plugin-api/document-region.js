// The document region attached to one element of a surface page. It is the "document region" of docs/spec/native-surfaces.md.
//
// The host places a document webview inside the surface webview, positioned with the viewport margins that this module reports. The
// position and size of the element are followed with ResizeObserver and the window resize and scroll events. A layout in which
// only the position changes while the size of the element or an ancestor does not change shows up as a size change of an ancestor.

/** The name rule. The host checks with the same rule. */
export const DOCUMENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DOCUMENT_ACTIONS = Object.freeze(["back", "forward", "reload", "stop"]);

/** The streams of a document region (docs/spec/native-surfaces.md#document-streams). */
export const DOCUMENT_STREAMS = Object.freeze(["elements", "requests"]);

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
 * history is null until the attachment finishes and then tells whether the region restored a session history
 * (docs/spec/plugins.md#memory-saver); an attach reply without it rejects the attachment.
 */
export function attachRegion(port, element, name, view = element.ownerDocument.defaultView, options = {}) {
  if (!DOCUMENT_NAME.test(name)) throw new Error(`invalid document name ${JSON.stringify(name)}`);
  // A failure that does not return to a caller (a placement during observation) is reported as an error with this function.
  const { report } = options;
  if (typeof report !== "function") throw new TypeError(`document ${name} requires a report for its failures`);
  const listeners = new Set();
  let state = null;
  let detached = false;
  let history = null;
  let chain = Promise.resolve(port.attach(name)).then((reply) => {
    if (typeof reply?.history !== "boolean") throw new Error(`document ${name} attach reply has no history: ${JSON.stringify(reply)}`);
    history = reply.history;
  });
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

  // The stream subscriptions of this region by handle. A message can arrive before the reply of its subscribe call, so while a
  // subscribe call waits, the messages of a handle that is not yet known are kept until its reply.
  const streamListeners = new Map();
  const earlyStreamMessages = new Map();
  let pendingSubscribes = 0;
  const unlistenStreams = Promise.resolve(port.onStream((document, handle, message) => {
    if (document !== name || detached) return;
    const listener = streamListeners.get(handle);
    if (listener) {
      listener(message);
    } else if (pendingSubscribes > 0) {
      if (!earlyStreamMessages.has(handle)) earlyStreamMessages.set(handle, []);
      earlyStreamMessages.get(handle).push(message);
    }
    // A message of a handle that is not known and that no subscribe call waits for arrives after its close, so it is dropped.
  }));

  const placeAt = ({ insets, visible }) => queue(() => port.place(name, insets, visible));
  // default: the thrown value may not be an Error, so without message the value itself is written.
  const failed = (error) => report(`document ${name} place: ${error?.message ?? error}`);
  const stopObserving = options.observe === false ? () => {} : observeRegionInsets(element, view, placeAt, failed);

  return {
    name,
    _ready: chain,
    get state() { return state; },
    get history() { return history; },
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
    /**
     * Subscribes to a stream of the region and calls listener with each message of the subscription, in order. Resolves to a handle whose
     * close() ends the subscription. The subscription of a requests stream starts with the request log, and the first snapshot of an
     * elements stream follows.
     */
    subscribe(stream, listener) {
      if (!DOCUMENT_STREAMS.includes(stream)) return Promise.reject(new Error(`unknown document stream ${JSON.stringify(stream)}`));
      if (typeof listener !== "function") return Promise.reject(new TypeError(`document stream ${stream} requires a listener`));
      pendingSubscribes += 1;
      const opened = queue(() => port.subscribe(name, stream)).then((handle) => {
        streamListeners.set(handle, listener);
        // default: a handle that received no message before its reply has no early messages.
        const early = earlyStreamMessages.get(handle) ?? [];
        earlyStreamMessages.delete(handle);
        for (const message of early) listener(message);
        return handle;
      });
      const settled = () => {
        pendingSubscribes -= 1;
        // The last reply has come, so the messages that are still unclaimed belong to closed subscriptions.
        if (pendingSubscribes === 0) earlyStreamMessages.clear();
      };
      opened.then(settled, settled);
      return opened.then((handle) => {
        let closed = false;
        return {
          stream,
          handle,
          close() {
            if (closed) return Promise.resolve();
            closed = true;
            streamListeners.delete(handle);
            return queue(() => port.unsubscribe(name, handle));
          },
        };
      });
    },
    detach() {
      const done = queue(() => port.detach(name));
      detached = true;
      stopObserving();
      listeners.clear();
      messageListeners.clear();
      streamListeners.clear();
      earlyStreamMessages.clear();
      unlisten.then((stop) => stop());
      unlistenMessages.then((stop) => stop());
      unlistenStreams.then((stop) => stop());
      return done;
    },
  };
}
