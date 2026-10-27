// The host calls of a surface document (docs/spec/logging.md#automatic-entrances). A surface is a separate webview without
// the page log of the main page, so the runtime of each application sends the calls of its `page` object through this wrapper.
// Every call is the event `page.call`, and the events of one turn travel to the host in one call `log`, like the events of
// the main page (`@soksak/plugin-api/log-batch.js`). The records of the document (`page.report`) are queued behind the same batcher so that the
// events of one document reach the host in the order they happened.
import { callEvent, failureOf } from "./host-calls.js";
import { createEventBatcher } from "@soksak/plugin-api/log-batch.js";
import { classOf } from "./event-classes.js";
import { logGate } from "./log-gate.js";

/**
 * `send(name, ...args)` sends one host call by its name and arguments and returns its answer; `log(request)` sends the request
 * of the host call `log`, which is not recorded because a recorded `log` call would record itself; `listen(name, fn)` calls `fn`
 * with the body of each host event of that name. A relay of events that fails is written to the console of the document, which
 * has no other place to report it.
 *
 * `followPolicy()` puts the policy in force of the host in the gate of the document (docs/spec/logging.md#policy): the action
 * `policy-read` once and each later host event `log-policy`. The runtime calls it at the load of a document of a surface or a
 * modal; the main page puts the policy of its setting in the gate itself. Until the read answers, the default policy is in force;
 * an event that arrived first is newer than the read, so the read then changes nothing.
 */
export function surfaceCalls({ send, log, listen }) {
  const report = (error) => console.error(error.message);
  const batcher = createEventBatcher({ call: log, report, classify: classOf, gate: logGate });
  const apply = (classes) => {
    try {
      logGate.set(classes);
    } catch (error) {
      report(new Error(`log policy: ${error.message}`));
    }
  };
  return {
    followPolicy() {
      let announced = false;
      Promise.resolve(listen("log-policy", ({ classes }) => { announced = true; apply(classes); })).catch(report);
      Promise.resolve(log({ action: "policy-read" })).then((answer) => { if (!announced) apply(answer?.classes); }).catch(report);
    },
    call(name, ...args) {
      const started = performance.now();
      const ended = (ok, failure) => {
        // The gate is asked before the arguments are serialized: a call that the policy does not store costs one branch and is counted.
        if (!batcher.gate("call", ok ? "debug" : "warn")) return;
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
