// The host-assigned generations of native view and plugin-host source incarnations
// (docs/spec/declared-ui.md, status mapping).
let floor = 0;
let pluginHosts = new Map();
let views = new Map();
const registrationListeners = new Map();
const endedListeners = new Set();

function tableOf(surface) {
  return surface === null ? pluginHosts : views;
}

function identityOf(plugin, surface) {
  return surface === null ? plugin : surface;
}

function listenerSet(surface, identity) {
  let byIdentity = registrationListeners.get(surface);
  if (!byIdentity) {
    byIdentity = new Map();
    registrationListeners.set(surface, byIdentity);
  }
  let listeners = byIdentity.get(identity);
  if (!listeners) {
    listeners = new Set();
    byIdentity.set(identity, listeners);
  }
  return listeners;
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
  for (const listener of registrationListeners.get(surface)?.get(identity) ?? []) listener(generation);
  return true;
}

/** Calls listener with the current generation and each later accepted registration for this source. */
export function onSourceOriginRegistered(plugin, surface, listener) {
  if (typeof plugin !== "string" || plugin === "" || (surface !== null && (typeof surface !== "string" || surface === "")) ||
      typeof listener !== "function") {
    throw new TypeError("declared UI source registration listener requires a plugin, source and function");
  }
  const identity = identityOf(plugin, surface);
  const listeners = listenerSet(surface, identity);
  listeners.add(listener);
  const current = tableOf(surface).get(identity);
  if (current !== undefined) listener(current);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (listeners.size === 0) {
      const byIdentity = registrationListeners.get(surface);
      byIdentity?.delete(identity);
      if (byIdentity?.size === 0) registrationListeners.delete(surface);
    }
  };
}

/** Removes a source only when its end event names the exact current generation. */
export function endSourceOrigin(plugin, surface, generation) {
  const table = tableOf(surface);
  const identity = identityOf(plugin, surface);
  if (table.get(identity) !== generation) return false;
  table.delete(identity);
  for (const listener of endedListeners) listener({ plugin, surface, generation });
  return true;
}

/** Calls listener synchronously after an exact current source generation is retired. */
export function onSourceOriginEnded(listener) {
  if (typeof listener !== "function") throw new TypeError("source end listener requires a function");
  endedListeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    endedListeners.delete(listener);
  };
}

/** Returns the current generation of a source, or undefined when it has no active native incarnation. */
export function sourceOrigin(plugin, surface) {
  return tableOf(surface).get(identityOf(plugin, surface));
}
