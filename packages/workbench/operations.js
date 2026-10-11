// The operations of the page that change the application: installing, updating, enabling and removing a plugin, opening and closing
// a window, opening and removing a project, changing a setting, and updating the application (docs/spec/logging.md#operation-chains).
//
// The page assigns a correlation identifier `p<time origin>.<n>` when an operation starts and stores the first event of its chain
// with it. The host calls that carry the operation out take the identifier as their options (`host.call(name, arg, {cids})`), so
// the event `page.call` of the page and the event `host.binding.call` of the host carry it too, and the audit joins them.

// The sink that stores an event with its identifiers. The log of the page installs it (page-log.js); this module imports no host,
// so the modules that start operations load without the application host.
let sink = null;
let counter = 0;

/** Installs the function that stores `(event, fields, cids)`. */
export function installOperationSink(next) {
  sink = next;
}

/**
 * Starts an operation: assigns its identifier, stores the event `event` with `fields` and the identifier, and returns the list of
 * identifiers to pass with the host calls of the operation. A page without the application host stores nothing.
 */
export function beginOperation(event, fields) {
  counter += 1;
  const cids = [`p${Math.round(performance.timeOrigin)}.${counter}`];
  // default: a page without the application host has no sink and stores nothing.
  sink?.(event, fields, cids);
  return cids;
}
