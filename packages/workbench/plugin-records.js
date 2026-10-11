// What the page offers to the recording functions of a plugin runtime (`createPluginRuntime` of `@soksak/plugin-api`): the event
// writer of the page with its level gate, and the performance trace with its switch. The surface contexts and the contexts of the
// state modules take the same object, so a plugin records through the same writers in both.
import { emitEvent, eventEnabled } from "./page-log.js";
import { trace, traceEnabled } from "./performance.js";

export const pluginRecords = Object.freeze({
  // events: forwarded
  log: (level, event, fields, cids) => { emitEvent(level, event, fields, cids); },
  logEnabled: eventEnabled,
  // The page trace writes the event while the performance trace is on (docs/spec/plugins.md#tracing).
  trace: (event, fields) => { trace(event, fields); },
  traceEnabled,
});
