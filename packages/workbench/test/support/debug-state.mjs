// Shared helpers of the state view tests (docs/spec/debug.md). Each test file of debug-state-ui-*.test.mjs runs in its own process, so the
// first log batch of that process takes the clock calls of its case. The page modules are imported only after the case of the test is
// selected (openDebugView), so this module imports the notice store dynamically.
import { openDebugView } from "./debug-document.mjs";

let store = null;
/** Opens the debug view of the case and keeps the notice store of the page for shownText. */
export const openState = async (name) => {
  const view = await openDebugView(name);
  store = (await import("../../tab-reports.js")).notificationStore();
  return view;
};
/** The message of the error that the view shows through the notice path (docs/spec/notifications.md#toasts), or null when none is shown. */
export const shownText = () => store.textOf("debug");
export const linesText = () => [...document.querySelectorAll('[data-expose="core.debug.state.line"]')].map((el) => el.textContent);
export const diffText = () => [...document.querySelectorAll('[data-expose="core.debug.state.difference"]')].map((el) => el.textContent);
export const recordCalls = (wire) => wire.calls.filter((call) => call.name === "debugRecord");
