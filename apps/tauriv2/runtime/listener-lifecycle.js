/** native listener를 등록하고 이 페이지가 unload될 때 모든 등록을 해제한다. */
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
    // default: 계약 테스트는 DOM root를 제공하지 않을 수 있으며, 이때 등록할 native listener가 없다.
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
