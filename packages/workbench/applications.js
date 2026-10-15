// The applications that connector plugins connected (docs/spec/installation.md#applications), which a surface reads
// through runtime.applications. The plugin state of the host owns the record; installed-plugins sets the function that
// reads it and tells each change.

const listeners = new Set();

let readApplications = null;

/** Sets the function that reads the record of the connected applications. installed-plugins sets it. */
export function setConnectedApplications(fn) {
  readApplications = fn;
}

/** The connected applications by id. It is an error before the reading function is set. */
export function connectedApplications() {
  if (!readApplications) throw new Error("the connected applications are not available before the plugin state starts");
  return readApplications();
}

/** Tells that the record may have changed. */
export function notifyConnectedApplications() {
  for (const fn of listeners) fn();
}

/** Registers a function to call when the record may have changed. It returns the function that ends the registration. */
export function onConnectedApplications(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
