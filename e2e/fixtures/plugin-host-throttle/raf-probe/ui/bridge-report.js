/** Reports bridge failures through the browser error hook and keeps ordinary bridge events in the console. */
export function createBridgeReporter({ reportError, console }) {
  if (typeof reportError !== "function") throw new TypeError("createBridgeReporter requires reportError");
  if (typeof console?.debug !== "function" || typeof console?.info !== "function" ||
      typeof console?.error !== "function") {
    throw new TypeError("createBridgeReporter requires console debug, info, and error methods");
  }
  return (event) => {
    if (event?.kind === "open-calls") {
      console.debug("view bridge open calls", event);
      return;
    }
    if (event?.kind === "skipped" ||
        (event?.kind === "peer-lost" && event.reason === "surface-closed") ||
        (event?.kind === "stalled" && event.reason === "surface-closed")) {
      console.info("view bridge closed or coalesced", event);
      return;
    }

    const fields = [];
    if (typeof event?.where === "string") fields.push(event.where);
    if (typeof event?.text === "string") fields.push(event.text);
    if (event?.error !== undefined) fields.push(`report error: ${event.error?.message ?? String(event.error)}`);
    const message = fields.length > 0
      ? fields.join(": ")
      : `view bridge ${typeof event?.kind === "string" ? event.kind : "report"}: ${JSON.stringify(event)}`;
    try {
      reportError(new Error(message));
    } catch (error) {
      console.error(`plugin-host RAF fixture error report failed: ${error?.message ?? String(error)}`);
    }
  };
}

/** Builds the options the RAF fixture passes to createViewBridge. */
export function createRafProbeBridgeOptions({ handler, reportError, console }) {
  if (typeof handler?.postMessage !== "function") {
    throw new TypeError("createRafProbeBridgeOptions requires a view message handler");
  }
  return { handler, report: createBridgeReporter({ reportError, console }) };
}
