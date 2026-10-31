// The host-assigned generations of the native view sources (docs/spec/native-surfaces.md#view-surfaces). Each view source has a
// window-wide generation, which the host assigns and reports. The workbench accepts a view command, a view event, or a source
// lifecycle event only for the current generation of its surface.
//
// The host reports the lifecycle with the events declared-ui-source-registered and declared-ui-source-ended and answers the query
// declaredSourceOrigins with the current generations. These are the names the host sends today; the registration of a view source is
// the same record under those names.
import { host as bridge } from "@soksak/runtime";

let floor = 0;
let views = new Map();
const registrationListeners = new Map();
const endedListeners = new Set();

// Lifecycle events that arrive before the query answer are kept and applied after it, in arrival order.
let bufferedEvents = [];
let originSnapshotReady = false;
let listenerReady = null;
let ingressReady = null;

function report(error) {
  dispatchEvent(new ErrorEvent("error", { message: `source origin ingress: ${error?.message ?? error}` })); // default: thrown non-Error values are included as their text.
}

/** Seeds the current generations and high-watermark returned atomically by the native host. */
export function seedSourceOrigins(snapshot) {
  if (!snapshot || !Number.isSafeInteger(snapshot.floor) || snapshot.floor < 0 || !snapshot.views) {
    throw new TypeError("view source origin snapshot is invalid");
  }
  const result = new Map(Object.entries(snapshot.views));
  for (const [identity, generation] of result) {
    if (!identity || !Number.isSafeInteger(generation) || generation < 1 || generation > snapshot.floor) {
      throw new TypeError("view source origin snapshot has an invalid generation");
    }
  }
  views = result;
  floor = snapshot.floor;
}

/** Accepts a source registration only when it names the seeded or a newer source generation. */
export function registerSourceOrigin(plugin, surface, generation) {
  if (typeof plugin !== "string" || plugin === "" || typeof surface !== "string" || surface === "" ||
      !Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError("view source registration requires a plugin, surface and positive generation");
  }
  const current = views.get(surface);
  if (generation <= floor) return current === generation;
  floor = generation;
  views.set(surface, generation);
  for (const listener of registrationListeners.get(surface) ?? []) listener(generation); // default: a source without observers has nobody to notify.
  return true;
}

/** Calls listener with the current generation and each later accepted registration for this source. */
export function onSourceOriginRegistered(plugin, surface, listener) {
  if (typeof plugin !== "string" || plugin === "" || typeof surface !== "string" || surface === "" || typeof listener !== "function") {
    throw new TypeError("view source registration listener requires a plugin, surface and function");
  }
  if (!registrationListeners.has(surface)) registrationListeners.set(surface, new Set());
  const listeners = registrationListeners.get(surface);
  listeners.add(listener);
  const current = views.get(surface);
  if (current !== undefined) listener(current);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (listeners.size === 0) registrationListeners.delete(surface);
  };
}

/** Removes a source only when its end event names the exact current generation. */
export function endSourceOrigin(plugin, surface, generation) {
  if (views.get(surface) !== generation) return false;
  views.delete(surface);
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
  return views.get(surface);
}

function receiveLifecycle(event, ended) {
  if (!event || typeof event !== "object" || typeof event.plugin !== "string" || event.plugin === "") {
    throw new TypeError("view source lifecycle event requires a plugin id");
  }
  if (typeof event.surface !== "string" || event.surface === "") {
    throw new TypeError(`view source lifecycle event of ${event.plugin} requires a surface`);
  }
  if (!Number.isSafeInteger(event.generation) || event.generation < 1) {
    throw new TypeError("view source lifecycle event requires a positive source generation");
  }
  if (ended) endSourceOrigin(event.plugin, event.surface, event.generation);
  else registerSourceOrigin(event.plugin, event.surface, event.generation);
}

function consumeBuffered({ name, value }) {
  try {
    receiveLifecycle(value, name === "declared-ui-source-ended");
  } catch (error) {
    report(error);
  }
}

/** Installs the window listeners of the source lifecycle events before the query answer, and starts no source. */
export function prepareSourceOriginIngress() {
  if (listenerReady !== null) return listenerReady;
  if (!bridge) {
    listenerReady = Promise.resolve(() => {});
    return listenerReady;
  }
  try {
    const names = ["declared-ui-source-registered", "declared-ui-source-ended"];
    listenerReady = Promise.allSettled(names.map((name) => Promise.resolve(bridge.on(name, (event) => {
      if (originSnapshotReady) consumeBuffered({ name, value: event });
      else bufferedEvents.push({ name, value: event });
    })))).then((results) => {
      const installed = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) {
        installed.forEach((unsubscribe) => { if (typeof unsubscribe === "function") unsubscribe(); });
        throw failure.reason;
      }
      if (installed.some((unsubscribe) => typeof unsubscribe !== "function")) {
        installed.forEach((unsubscribe) => { if (typeof unsubscribe === "function") unsubscribe(); });
        throw new TypeError("view source ingress listener did not return an unsubscribe function");
      }
      return () => installed.forEach((unsubscribe) => unsubscribe());
    });
  } catch (error) {
    listenerReady = Promise.reject(error);
  }
  listenerReady.catch((error) => error);
  return listenerReady;
}

/** Seeds the source generations from the host and applies the lifecycle events received before the seed. */
export function startSourceOriginIngress() {
  if (ingressReady !== null) return ingressReady;
  if (!bridge) {
    originSnapshotReady = true;
    ingressReady = prepareSourceOriginIngress();
    return ingressReady;
  }
  ingressReady = prepareSourceOriginIngress().then((unsubscribe) => {
    return bridge.call("declaredSourceOrigins").then((snapshot) => {
      seedSourceOrigins(snapshot);
      originSnapshotReady = true;
      const queued = bufferedEvents;
      bufferedEvents = [];
      for (const event of queued) consumeBuffered(event);
      return unsubscribe;
    }).catch((error) => {
      unsubscribe();
      throw error;
    });
  });
  // Startup awaits this promise after its synchronous first draw and asynchronous storage setup. Observe a rejection immediately
  // to prevent an early unhandled-rejection event; this handler returns the cause as a fulfilled observation value, while callers
  // still receive the original rejected promise at their startup boundary.
  ingressReady.catch((error) => error);
  return ingressReady;
}
