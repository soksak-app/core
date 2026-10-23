// Core observation of the actual surface document. The view bridge owns its relay and the plugin owns no copy.
import { auditDocument, documentRoots, onDocumentBinding } from "./binder.js";

const NAMES = new Set(["core.surface.document", "core.surface.input", "core.surface.hit"]);
/** Core names owned by a surface document, excluding main-document commands such as core.surface.menu. */
export const surfaceDocumentEntry = (name) => NAMES.has(name);

const INPUT_TYPES = ["pointerdown", "pointerup", "pointermove", "click", "wheel", "keydown"];
const MODIFIERS = [["shiftKey", "shift"], ["altKey", "alt"], ["ctrlKey", "control"], ["metaKey", "command"]];
const INPUT_KEPT = 32;

/** Observes the current document and releases every listener when disposed. */
export function observeSurfaceDocument(view) {
  const document = view.document;
  const root = document.documentElement;
  const events = [];
  const documentListeners = new Set();
  const inputListeners = new Set();
  const observedRoots = new WeakSet();
  let sequence = 0;
  let disposed = false;
  const discover = () => {
    for (const part of documentRoots(root)) if (!observedRoots.has(part)) {
      mutation.observe(part, { subtree: true, childList: true, attributes: true,
        attributeFilter: ["data-command", "data-expose", "role", "contenteditable", "style", "class"] });
      observedRoots.add(part);
    }
  };
  const readDocument = () => {
    discover();
    const viewport = { width: view.visualViewport.width, height: view.visualViewport.height };
    const style = view.getComputedStyle(root);
    return {
      url: view.location.href, timeOrigin: view.performance.timeOrigin, readyState: document.readyState,
      themed: Boolean(style.getPropertyValue("--bg") || (style.colorScheme && style.colorScheme !== "normal")),
      scale: view.devicePixelRatio,
      // default: the body may not exist yet; its absent scroll extent is zero.
      body: { width: Math.max(viewport.width, root.scrollWidth, document.body?.scrollWidth ?? 0),
        height: Math.max(viewport.height, root.scrollHeight, document.body?.scrollHeight ?? 0) },
      viewport, filter: style.filter, unbound: auditDocument(root),
    };
  };
  const readInput = () => events.slice();
  const notifyDocument = () => {
    if (disposed) return;
    const value = readDocument();
    for (const listener of documentListeners) listener(value);
  };
  const mutation = new view.MutationObserver(notifyDocument);
  discover();
  const unbind = onDocumentBinding(document, notifyDocument);
  const onInput = (event) => {
    // default: keys have no pointer coordinates, and pointers have no key.
    events.push({ sequence: ++sequence, type: event.type, trusted: event.isTrusted,
      x: event.clientX ?? null, y: event.clientY ?? null, key: event.key ?? null,
      modifiers: MODIFIERS.filter(([property]) => event[property]).map(([, name]) => name) });
    if (events.length > INPUT_KEPT) events.shift();
    for (const listener of inputListeners) listener(readInput());
  };
  for (const type of INPUT_TYPES) view.addEventListener(type, onInput, true);
  document.addEventListener("readystatechange", notifyDocument);
  view.addEventListener("resize", notifyDocument);
  view.visualViewport.addEventListener("resize", notifyDocument);
  const subscribe = (listeners) => (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    document: { read: readDocument, subscribe: subscribe(documentListeners) },
    input: { read: readInput, subscribe: subscribe(inputListeners) },
    hit: ({ x, y }) => document.elementFromPoint(x, y) !== null,
    dispose() {
      if (disposed) return;
      disposed = true;
      mutation.disconnect();
      unbind();
      for (const type of INPUT_TYPES) view.removeEventListener(type, onInput, true);
      document.removeEventListener("readystatechange", notifyDocument);
      view.removeEventListener("resize", notifyDocument);
      view.visualViewport.removeEventListener("resize", notifyDocument);
      documentListeners.clear();
      inputListeners.clear();
    },
  };
}
