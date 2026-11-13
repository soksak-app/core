// The runtime for workbench tests. It has no native host unless a test selects the page-wire case that answers the calls of the page.
import { openPageWire } from "./page-wire.js";

export let host = null;
export const page = null;

export const openStore = () => {
  throw new Error("workbench tests do not open a store");
};

export const windows = null;

/**
 * Makes the page-wire case of the name the host of the workbench until the returned finish is called. The test selects the case before
 * it imports or calls a module that reads host, and finish checks that every step of the case was played. release settles the oldest
 * held reply, and deliverNotice delivers the next notice of the case to the listeners of the page.
 */
export function selectPageWire(name) {
  const wire = openPageWire(name);
  host = { call: wire.call, on: wire.on };
  return {
    calls: wire.calls,
    release: wire.release,
    deliverNotice: wire.deliverNotice,
    finish() {
      host = null;
      wire.finish();
    },
  };
}
