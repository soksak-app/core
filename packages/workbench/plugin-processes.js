// Core statuses of the plugin processes (docs/plans/plugin-processes.md, rules 2, 3 and 6). Each status holds a list of records
// that carry the plugin id. The lists are empty until the call layer (F212.3-1) and the declared UI snapshots (F212.3-2) fill them.
//
// core-exposure.js registers each reader under the name that exposure.json declares.

/** The open calls of each plugin: `{plugin, count, oldestStartedAt}`. */
export const openCalls = () => [];

/** The losses of each plugin: `{plugin, skipped, stalled, abandoned, lateReplies, timeouts, peerLost}`. */
export const losses = () => [];

/** The responsiveness of each plugin view surface: `{plugin, surface, responsive}`. */
export const views = () => [];
