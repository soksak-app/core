// The host calls of a surface document (docs/spec/logging.md#automatic-entrances). A surface is a separate webview without
// the page log of the main page, so the runtime of each application sends the calls of its `page` object through this wrapper.
// Every call is the event `page.call`, and the events of one turn travel to the host in one call `log`, like the events of
// the main page (log-batch.js). The records of the document (`page.report`) are queued behind the same batcher so that the
// events of one document reach the host in the order they happened.
import { callEvent, failureOf } from "./host-calls.js";
import { createEventBatcher } from "./log-batch.js";

/**
 * `send(name, ...args)` sends one host call by its name and arguments and returns its answer; `log(request)` sends the request
 * of the host call `log`, which is not recorded because a recorded `log` call would record itself. A relay of events that fails
 * is written to the console of the document, which has no other place to report it.
 */
export function surfaceCalls({ send, log }) {
  const batcher = createEventBatcher({ call: log, report: (error) => console.error(error.message) });
  return {
    call(name, ...args) {
      const started = performance.now();
      const ended = (ok, failure) => {
        const { level, event, fields, cids } = callEvent({ name, args, micros: Math.round((performance.now() - started) * 1000), ok, ...failure });
        // events: page.call
        batcher.emit(level, event, fields, cids);
      };
      let result;
      try {
        result = Promise.resolve(send(name, ...args));
      } catch (error) {
        ended(false, failureOf(error));
        return Promise.reject(error);
      }
      return result.then((answer) => {
        ended(true, {});
        return answer;
      }, (error) => {
        ended(false, failureOf(error));
        throw error;
      });
    },
    /** Queues an event of the document; the promise ends when the batch that carries it was relayed. */
    // events: forwarded
    record: (level, event, fields) => batcher.emitAndWait(level, event, fields),
  };
}
