// The surfaces whose image detach was pending when the host built the start document. The page neither places nor
// mounts such a surface, nor opens its background session, until the host tells the end of its detaches with
// image-detach-ended (docs/spec/sidecars.md).

const waiting = new Set();
const failed = new Map();

/** Holds the surfaces of the start document member pendingSurfaces. */
export function holdImageDetachSurfaces(surfaces) {
  if (!Array.isArray(surfaces) || surfaces.some((surface) => typeof surface !== "string" || surface === "")) {
    throw new TypeError(`start document pendingSurfaces must be an array of surface ids, not ${JSON.stringify(surfaces)}`);
  }
  for (const surface of surfaces) waiting.add(surface);
}

/**
 * The hold of a surface: `waiting` while its detaches are pending, `{error}` when one of them failed, so the tab stays
 * unmounted with that error while this page runs, and null for a surface that is not held.
 */
export function imageDetachHold(surface) {
  if (waiting.has(surface)) return "waiting";
  if (failed.has(surface)) return { error: failed.get(surface) };
  return null;
}

/**
 * Applies an image-detach-ended event `{surface, error}` and returns whether it released a surface of this page. An end
 * of a surface that the start document did not list belongs to no surface of this page and changes nothing.
 */
export function imageDetachEnded(event) {
  if (typeof event?.surface !== "string" || event.surface === ""
      || !(event.error === null || (typeof event.error === "string" && event.error !== ""))) {
    throw new TypeError(`invalid image-detach-ended event ${JSON.stringify(event)}`);
  }
  if (!waiting.delete(event.surface)) return false;
  if (event.error !== null) failed.set(event.surface, event.error);
  return true;
}
