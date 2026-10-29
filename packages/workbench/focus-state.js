// The keyboard focus of the window. A surface module mounts inside a shadow root of the main document, so the activeElement of the document and the target of a focus
// event appear as the shadow host. The focus follows the shadow root and is read from the actual element. A view is a document of its own, which
// reports its focused element (view-focus.js); the first responder of the window decides which document holds the focus (docs/spec/exposure.md#keyboard-focus).
import { focusedExposedElement, focusedExposure } from "@soksak/plugin-api";
import { currentResponder, viewFocusOf } from "./view-focus.js";

/** The id of the surface that the element belongs to. It is null for an element of the main document. */
function surfaceOf(element) {
  const root = element.getRootNode();
  // default: an element outside a shadow root belongs to the main document, so it has no surface (null).
  if (!root.host) return null;
  // default: a shadow root outside a surface slot does not belong to a surface (null).
  return root.host.closest("[data-native-surface-id]")?.dataset.nativeSurfaceId ?? null;
}

/**
 * The name of the exposed element that has keyboard focus, its index inside its document (or shadow root), and the surface id. The first responder
 * of the window selects the document: the main page reads its own focused element, a view surface the element that its view reported, and every
 * other owner has no exposed focus. It is null when the focus is outside an exposed element.
 */
export function focusState(document) {
  const responder = currentResponder();
  if (responder.owner === "surface") {
    const reported = viewFocusOf(responder.surface);
    return reported === null ? null : { ...reported, surface: responder.surface };
  }
  if (responder.owner !== "page") return null;
  const element = focusedExposedElement(document);
  if (element === null) return null;
  return { ...focusedExposure(document), surface: surfaceOf(element) };
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
