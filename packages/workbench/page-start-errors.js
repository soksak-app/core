// An error that stops the main page from starting is written to the application log when it occurs
// (docs/spec/native-host.md#page-start). The page's own error display is installed after the modules that can fail,
// so this handler comes first and the page removes it after its first screen.

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
 * Starts writing the errors of the start document.
 *
 *   target  receives `error` (captured, so a module that fails to load is seen) and `unhandledrejection`
 *   report  writes one line to the application log
 *
 * Returns `{ finish }`, which removes the handlers; calling it again does nothing.
 */
export function installPageStartErrors({ target, report }) {
  const written = new Set();
  const write = (text) => {
    const line = `error: page start: ${text}`;
    if (written.has(line)) return;
    written.add(line);
    report(line);
  };
  const onError = (event) => write(errorText(event));
  const onRejection = (event) => write(rejectionText(event.reason));
  target.addEventListener("error", onError, { capture: true });
  target.addEventListener("unhandledrejection", onRejection);
  return {
    finish() {
      target.removeEventListener("error", onError, { capture: true });
      target.removeEventListener("unhandledrejection", onRejection);
    },
  };
}
