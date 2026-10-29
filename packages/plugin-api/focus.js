// The exposed element that has keyboard focus in one document. An element can sit inside a shadow root, so the active element of
// the document and of each shadow root is followed to the innermost element (docs/spec/exposure.md#keyboard-focus).

/** The innermost element that has focus. It is null when nothing has focus. */
export function deepActive(document) {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

/** The exposed element that has focus, or null when the focus is outside an exposed element. */
export function focusedExposedElement(document) {
  const element = deepActive(document)?.closest("[data-expose]");
  if (!element || element === document.body) return null;
  return element;
}

/**
 * The name of the exposed element that has focus and its index among the elements of that name in its document or shadow root;
 * null when the focus is outside an exposed element.
 */
export function focusedExposure(document) {
  const element = focusedExposedElement(document);
  if (element === null) return null;
  const name = element.dataset.expose;
  return { name, index: [...element.getRootNode().querySelectorAll(`[data-expose="${name}"]`)].indexOf(element) };
}
