// Selects the plugin surfaces that the audit of the running documents must judge (docs/spec/exposure.md).

/**
 * Returns the visible view surfaces whose page does not expose core.surface.document. A view is a separate document, so the audit
 * cannot judge its controls without that status, and the audit fails for each of them.
 */
export function unauditedViews(surfaces) {
  return surfaces.filter((surface) => surface.visible && surface.composition === "view"
    && !surface.exposes.includes("status core.surface.document"));
}
