import { mountSurface } from "./surface-modules.js";

const slots = new Map();
let root = null;

function slotFor(id) {
  if (!root) {
    root = document.createElement("div");
    root.hidden = true;
    root.dataset.retainedSurfaceMounts = "";
    document.body.append(root);
  }
  let slot = slots.get(id);
  if (!slot) {
    slot = document.createElement("div");
    root.append(slot);
    slots.set(id, slot);
  }
  return slot;
}

/** Mounts a loaded hidden view in a hidden DOM slot after the placement policy authorizes its context. */
export async function prepareRetainedSurface(surface) {
  if (!surface || typeof surface.id !== "string" || !surface.id
      || surface.surface?.composition?.kind !== "view") {
    throw new TypeError("retained surface preparation requires a view descriptor");
  }
  const slot = slotFor(surface.id);
  try {
    const options = surface.retainedTextSize === undefined
      ? undefined
      : { retainedTextSize: surface.retainedTextSize };
    await mountSurface(slot, surface.surface, options);
  } catch (error) {
    slot.remove();
    slots.delete(surface.id);
    if (slots.size === 0 && root) {
      root.remove();
      root = null;
    }
    throw error;
  }
}

/** Removes parked slots after placement released a tab or moved it into the current plane. */
export function releaseRetainedSurfaceSlots(record, retained, unload = []) {
  if (!record || !Array.isArray(record.surfaces) || !(retained instanceof Set) || !Array.isArray(unload)) {
    throw new TypeError("retained surface cleanup requires a compositor record, retained ids, and unload ids");
  }
  const active = new Set(record.surfaces.map(({ id }) => id));
  for (const [id, slot] of slots) {
    if (retained.has(id) && !active.has(id) && !unload.includes(id)) continue;
    slot.remove();
    slots.delete(id);
  }
  if (slots.size === 0 && root) {
    root.remove();
    root = null;
  }
}
