// Shared helpers of the debug view timeline tests (docs/spec/debug.md#timeline). Each test file of debug-timeline-ui-*.test.mjs runs
// in its own process, so each first log batch of a page takes the clock calls of its case. The page modules are imported only after
// the case of the test is selected (openDebugView), so this module imports them dynamically.
import { openDebugView } from "./debug-document.mjs";

/** The requests of the host call `logQuery` that the page sent, in order. */
export const queriesOf = (wire) => wire.calls.filter((call) => call.name === "logQuery").map((call) => call.payload);
/** The states of the host call `debugFollow` that the page sent, in order. */
export const followsOf = (wire) => wire.calls.filter((call) => call.name === "debugFollow").map((call) => call.payload.following);
/** The requests of the host call `debugSaveText` that the page sent, in order. */
export const savesOf = (wire) => wire.calls.filter((call) => call.name === "debugSaveText").map((call) => call.payload);
// The notice store of the page, read after the wire of the case is selected (openDebugView imports the page modules).
let notices = null;
/** Opens the debug view of the case and keeps the notice store of the page for the error helpers. */
export const open = async (name, options) => {
  const view = await openDebugView(name, options);
  notices = (await import("../../tab-reports.js")).notificationStore();
  return view;
};
/** The message of the error that the view shows through the notice path (docs/spec/notifications.md), or null when none is shown. */
export const shownText = () => notices.textOf("debug");
export const shownWhere = () => (shownText() === null ? null : "debug");
export const settled = () => new Promise((resolve) => setImmediate(resolve));
/** The notice `debug-log-changed` of a file reaches the listener of the page, whose queries end before the next turn. */
export const changed = async (wire) => {
  wire.deliverNotice();
  await settled();
};

export const WARNING = "저장한 파일에는 입력한 글자가 들어 있을 수 있다.";
export const rowsText = () => [...document.querySelectorAll('[data-expose="core.debug.timeline.row"]')].map((r) => r.textContent);
export const names = () => rowsText().map((text) => text.split(" ")[3]);
