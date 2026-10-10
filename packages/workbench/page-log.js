// The records of the page (docs/spec/diagnostics.md#forms, docs/spec/logging.md#writers). A failure and an observation of the
// page are the events `page.record.error` and `page.record.info` with the fields `where` and `text`. The page queues them
// without waiting and relays the records of one turn to the host in one batch through the call `log`. A page without the
// application host (the browser example) writes to its console.
import { host } from "@soksak/runtime";
import { createEventBatcher } from "./log-batch.js";
import { recordOf } from "./report-record.js";

// A failure to relay cannot be reported through the relay, so it goes to the console.
const batcher = host
  ? createEventBatcher({ call: (request) => host.call("log", request), report: (error) => console.error(error.message) })
  : null;

/**
 * Stores a record of the page and returns a promise that ends when the batch that carries it was relayed. `level` is `error`
 * for a failure and `info` for a state without a failure; `line` is `<where>: <text>`, and a line without `: ` has the place
 * `page`.
 */
export function reportRecord(level, line) {
  if (!batcher) {
    (level === "error" ? console.error : console.info)(line);
    return Promise.resolve();
  }
  const { where, text } = recordOf(level, line);
  return batcher.emitAndWait(level, `page.record.${level}`, { where, text });
}
