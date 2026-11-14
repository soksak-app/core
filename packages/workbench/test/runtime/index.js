// The runtime for workbench tests. It has no native host unless a test selects the page-wire case that answers the calls of the page.
import { hostWindows } from "@soksak/workbench/host-windows.js";
import { openPageWire } from "./page-wire.js";
import { createPageClock } from "./page-clock.js";

export let host = null;
// The clock that the event batcher of the page reads; a test moves it with `clock.advance(ms)`.
export const clock = createPageClock();
export const page = null;

export const openStore = () => {
  throw new Error("workbench tests do not open a store");
};

// The window interface of the native runtime over the selected case, as the runtime module of a native application exports it.
export let windows = null;

/**
 * Makes the page-wire case of the name the host of the workbench until the returned finish is called. The test selects the case before
 * it imports or calls a module that reads host, and finish checks that every step of the case was played. release settles the oldest
 * held reply, and deliverNotice delivers the next notice of the case to the listeners of the page.
 */
export function selectPageWire(name) {
  const wire = openPageWire(name);
  host = { call: wire.call, on: wire.on };
  windows = hostWindows(host);
  return {
    calls: wire.calls,
    unsubscribed: wire.unsubscribed,
    release: wire.release,
    deliverNotice: wire.deliverNotice,
    finish() {
      host = null;
      windows = null;
      wire.finish();
    },
  };
}
