// The transport of a declared UI status between the main page and its source (docs/spec/declared-ui.md, status mapping).
//
// The main page has no production connection to a view or a plugin host for the declared UI snapshot transport or for
// the pull of the current value, so this boundary gives no channel and no pull and a declared section stays cleared
// until its source has one. The channel and the pull that the tests give are fakes at this boundary.

/** The snapshot channel of a source, or null while the main page cannot open one. */
export const declaredChannel = () => null;

/** The pull of the current value of a source, or null while the main page cannot send one. */
export const declaredPull = null;
