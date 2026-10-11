// What the page offers to the recording functions of a plugin runtime (`createPluginRuntime` of `@soksak/plugin-api`): the event
// writer of the page and the performance trace.
import { emitEvent } from "./page-log.js";
import { trace } from "./performance.js";

export const pluginRecords = Object.freeze({
  // events: forwarded
  log: (level, event, fields, cids) => { emitEvent(level, event, fields, cids); },
  // The page trace writes the event while the performance trace is on (docs/spec/plugins.md#tracing).
  trace: (event, fields) => { trace(event, fields); },
});
