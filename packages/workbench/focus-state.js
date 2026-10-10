// The keyboard focus of the main document. A surface module mounts inside a shadow root of the main document, so the activeElement of the document and the target of a focus
// event appear as the shadow host. The focus follows the shadow root and is read from the actual element.

/** The innermost element that has focus. It is null when nothing has focus. */
function deepActive(document) {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

/** The id of the surface that the element belongs to. It is null for an element of the main document. */
function surfaceOf(element) {
  const root = element.getRootNode();
  // default: an element outside a shadow root belongs to the main document, so it has no surface (null).
  if (!root.host) return null;
  // default: a shadow root outside a surface slot does not belong to a surface (null).
  return root.host.closest("[data-native-surface-id]")?.dataset.nativeSurfaceId ?? null;
}

/**
 * The name of the public element that has keyboard focus, its sequence number inside its document (or shadow root), and the surface id.
 * It is null when the focus is outside a public element.
 */
export function focusState(document) {
  const element = deepActive(document)?.closest("[data-expose]");
  if (!element || element === document.body) return null;
  const name = element.dataset.expose;
  const root = element.getRootNode();
  return { name, index: [...root.querySelectorAll(`[data-expose="${name}"]`)].indexOf(element), surface: surfaceOf(element) };
}

/**
 * The name of the actual element that a focus event points to. Without a public name it is the tag name. It identifies the observation line and is not used for judgment.
 */
export function focusName(event) {
  const target = event.composedPath()[0];
  if (!(target instanceof target.ownerDocument.defaultView.Element)) return "unknown";
  // default: an element without a public name is recorded by its tag name. It only identifies the observation and is not used for judgment.
  return target.closest("[data-expose]")?.dataset.expose ?? target.tagName;
}
