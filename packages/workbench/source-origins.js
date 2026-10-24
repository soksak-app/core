// The host-assigned generations of native view and plugin-host source incarnations
// (docs/spec/declared-ui.md, status mapping).
let floor = 0;
let pluginHosts = new Map();
let views = new Map();

function tableOf(surface) {
  return surface === null ? pluginHosts : views;
}

function identityOf(plugin, surface) {
  return surface === null ? plugin : surface;
}

/** Seeds the current generations and high-watermark returned atomically by the native host. */
export function seedSourceOrigins(snapshot) {
  if (!snapshot || !Number.isSafeInteger(snapshot.floor) || snapshot.floor < 0 || !snapshot.pluginHosts || !snapshot.views) {
    throw new TypeError("declared UI source origin snapshot is invalid");
  }
  const read = (entries) => {
    const result = new Map(Object.entries(entries));
    for (const [identity, generation] of result) {
      if (!identity || !Number.isSafeInteger(generation) || generation < 1 || generation > snapshot.floor) {
        throw new TypeError("declared UI source origin snapshot has an invalid generation");
      }
    }
    return result;
  };
  pluginHosts = read(snapshot.pluginHosts);
  views = read(snapshot.views);
  floor = snapshot.floor;
}

/** Accepts a source lifecycle event only when it names the seeded or a newer source generation. */
export function registerSourceOrigin(plugin, surface, generation) {
  if (typeof plugin !== "string" || plugin === "" || (surface !== null && (typeof surface !== "string" || surface === "")) ||
      !Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError("declared UI source registration requires a plugin, source and positive generation");
  }
  const table = tableOf(surface);
  const identity = identityOf(plugin, surface);
  const current = table.get(identity);
  if (generation <= floor) return current === generation;
  floor = generation;
  table.set(identity, generation);
  return true;
}

/** Removes a source only when its end event names the exact current generation. */
export function endSourceOrigin(plugin, surface, generation) {
  const table = tableOf(surface);
  const identity = identityOf(plugin, surface);
  if (table.get(identity) !== generation) return false;
  table.delete(identity);
  return true;
}

/** Returns the current generation of a source, or undefined when it has no active native incarnation. */
export function sourceOrigin(plugin, surface) {
  return tableOf(surface).get(identityOf(plugin, surface));
}
