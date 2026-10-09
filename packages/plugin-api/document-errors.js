// The errors and unhandled rejections of the document of a surface or a modal. Nothing reads the console of such a
// document, so each is written to the application log when it occurs (docs/spec/diagnostics.md#forms). The main page
// writes its own start errors with the same texts (`packages/workbench/page-start-errors.js`); that module imports
// nothing so that it works when another module fails to load, and this one is loaded with the page API.

/** The text of an error event: its message with the file and line, or the address of a module that did not load. */
function errorText(event) {
  if (typeof event.message === "string" && event.message !== "") {
    const where = event.filename ? ` @ ${event.filename}:${event.lineno}` : "";
    return `${event.message}${where}`;
  }
  const element = event.target;
  if (element && typeof element.src === "string") return `cannot load ${element.src}`;
  if (element && typeof element.href === "string") return `cannot load ${element.href}`;
  return "an error event without a message or an address";
}

/** The text of a rejection: the message of an Error, or the value. */
const rejectionText = (reason) => (reason instanceof Error ? reason.message : String(reason));

/**
 * Starts writing the errors of this document.
 *
 *   target  receives `error` (captured, so a module that fails to load is seen) and `unhandledrejection`
 *   report  writes one text to the application log
 *
 * The same text is written once.
 */
export function installDocumentErrors({ target, report }) {
  const written = new Set();
  const write = (text) => {
    if (written.has(text)) return;
    written.add(text);
    report(text);
  };
  target.addEventListener("error", (event) => write(errorText(event)), { capture: true });
  target.addEventListener("unhandledrejection", (event) => write(rejectionText(event.reason)));
}
