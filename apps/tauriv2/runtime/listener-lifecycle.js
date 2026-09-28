/** Registers native listeners and releases every registration when this page unloads. */
export function createLifecycleListener(register, root = globalThis.window) {
  const active = new Set();
  let unloaded = false;
  const dispose = (entry, off) => {
    if (entry.disposed) return;
    entry.disposed = true;
    active.delete(entry);
    if (typeof off === "function") off();
  };
  const unload = () => {
    if (unloaded) return;
    unloaded = true;
    for (const entry of active) dispose(entry, entry.off);
  };
  for (const event of ["pagehide", "beforeunload", "unload"]) {
    // default: contract tests may provide no DOM root, so there is no native listener to register.
    root?.addEventListener?.(event, unload, { once: true });
  }
  return (event, listener) => {
    if (unloaded) return Promise.reject(new Error("cannot register a native listener after page unload"));
    const entry = { disposed: false, off: null };
    active.add(entry);
    return Promise.resolve(register(event, listener)).then((off) => {
      if (typeof off !== "function") throw new TypeError(`native listener ${event} did not return an unlisten function`);
      if (unloaded) {
        if (!entry.disposed) dispose(entry, off);
        else off();
        return () => {};
      }
      entry.off = off;
      return () => dispose(entry, off);
    }, (error) => {
      active.delete(entry);
      throw error;
    });
  };
}
