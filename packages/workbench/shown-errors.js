// The only path that shows an error to the user (docs/spec/exposure.md#error-presentation). An error is a notice of the kind error of the notice store
// (notices.js); its toasts, status lines and center entries are drawn by notice-view.js. The application log gets one record when the error
// appears or merges, which the store writes, so the record stays after the next draw removes the display.
import { notificationStore, onTabReports } from "./tab-reports.js";
import { mountNoticeView } from "./notice-view.js";

const TITLE_MAX = 120;
const TEXT_MAX = 1024;

/**
 * Shows the error text of the place where as an error notice whose origin is where, and writes its application log record when the error
 * appears or merges. The control whose operation failed keeps its label and its recovery actions (docs/spec/exposure.md). detail is kept only
 * in the log.
 */
export function showError(document, where, text, detail = "") {
  errorToasts(document).show(text, detail, where, where);
}

/** Withdraws the error of the origin where; its toast and status line close and its center entry stays, read. */
export function hideError(document, where) {
  errorToasts(document).withdraw(where);
}

const views = new WeakMap();

/** Returns the error display of a document: the notices of the page and the view that draws them into the document. */
export function errorToasts(document) {
  if (!views.has(document)) views.set(document, createErrorDisplay(document));
  return views.get(document);
}

// The error shows on one line: the control characters, the line breaks included, become " · ", and the title is the first TITLE_MAX characters of
// that line, the rest the text up to TEXT_MAX characters. The application log keeps the text as it was reported.
function titleAndText(text) {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " · ");
  const title = line.slice(0, TITLE_MAX);
  return { title: title === "" ? "error" : title, text: line.slice(TITLE_MAX, TITLE_MAX + TEXT_MAX) };
}

function createErrorDisplay(document) {
  const store = notificationStore();
  const view = mountNoticeView(document, store);
  return {
    /** Shows the failure of a named origin until that origin changes or recovers. An empty origin is an occurrence of its own. */
    show(reason, detail = "", origin = "", where = "workbench") {
      const text = String(reason);
      const { title, text: body } = titleAndText(text);
      store.show({ kind: "error", title, text: body, origin: origin === "" ? null : origin, detail, where, logText: text });
    },
    /** Withdraws the error of an origin. */
    withdraw(origin) {
      store.withdrawOrigin(origin);
    },
    /** The text of the error of an origin, closed or not, or null once the origin is withdrawn. */
    text: (origin) => store.textOf(origin),
    /** The text of the newest shown toast, or null. */
    newest: () => store.newestMessage(),
    /** Closes the shown toast with the text; false when no shown toast has it. */
    dismiss: (text) => store.closeMessage(text),
    /** Moves the notice stack to the foreground content of a dialog or the main document. */
    place: (root) => view.place(root),
    /** Calls fn when the notices change; returns the function that ends the call. */
    watch: (fn) => onTabReports(fn),
    /** Whether a close control of a toast no longer belongs to a shown toast in root. */
    obsoleteClose: (key, root) => view.obsoleteClose(key, root),
  };
}
