// The page side of the commands of a view (docs/spec/native-surfaces.md#view-surfaces). The page runs a command of a view for each
// exposure request of the command: it sends {id, command, params} to the view as viewRequest, and the view answers with the reply
// that the host delivers as view-reply. The call layer of plugin-api holds the open calls and the late replies, so the requests
// use the same rules as the calls of a plugin process (docs/spec/plugin-processes.md, rule 3): a command has no time limit, and
// its reply, the close of its surface or the end of the view ends it.

import { causeCids, createCalls } from "@soksak/plugin-api";

/** The code of a command that failed: EXPOSURE_ERRORS.failed of plugin-api. */
const FAILED_COMMAND = -32000;

/**
 * Creates the command layer of one view surface.
 *
 *     plugin      the plugin id of the view
 *     post        post(message): sends {id, command, params} to the view through viewRequest; rejects when the host refuses it
 *     report      report(event): receives the open calls, the peer losses and the late replies, as createCalls reports them
 *
 * Returns {run, receive, close}. run(name, params) resolves with the result of the view, or rejects with its error. receive(event)
 * takes a view-reply event {surface, plugin, id, result} or {surface, plugin, id, error}. close() ends every open call with surface-closed.
 * run(name, params, cids) carries the correlation identifiers of the cause of the request to the view, which passes them to the handler.
 */
export function createViewCommands({ plugin, post, report, generation = null, ...rest }) {
  if (typeof post !== "function" || typeof report !== "function") {
    throw new TypeError("createViewCommands requires the post and report functions");
  }
  // A command of a view has no time limit, so the former member that gave one is refused by its name.
  if (Object.hasOwn(rest, "timeoutOf")) throw new TypeError("createViewCommands takes no timeoutOf: a command of a view has no time limit");
  const unknown = Object.keys(rest);
  if (unknown.length) throw new TypeError(`createViewCommands has no option ${unknown.join(", ")}`);
  if (generation !== null && (!Number.isSafeInteger(generation) || generation < 1)) {
    throw new TypeError("createViewCommands requires a positive source generation when one is supplied");
  }
  // The listener of the call layer, which receive() delivers the replies of the view to. It is null after close().
  let deliver = null;
  const calls = createCalls({
    plugin,
    send: (message) => {
      // An accepted post stays open for the provider reply. The native host may instead return an explicit stale-source
      // cancellation, which settles the call without turning a source replacement into a user-visible error.
      const request = generation === null ? message : { ...message, generation };
      Promise.resolve().then(() => post(request)).then((disposition) => {
        if (disposition === null || disposition === undefined) return;
        if (typeof disposition !== "object" || disposition.cancelled !== true ||
            !Number.isSafeInteger(disposition.sourceGeneration) || disposition.sourceGeneration < 1) {
          deliver?.({ id: message.id, error: { code: FAILED_COMMAND, message: "native command post returned an invalid disposition" } }); // default: the view may close before the asynchronous post settles.
          return;
        }
        deliver?.({ id: message.id, result: disposition }); // default: the view may close before the asynchronous post settles.
      }, (error) => {
        // default: a refusal that is not an Error carries its value as the text.
        deliver?.({ id: message.id, error: { code: FAILED_COMMAND, message: String(error?.message ?? error) } });
      });
    },
    onMessage: (listener) => {
      deliver = listener;
      return () => { deliver = null; };
    },
    report,
  });
  return {
    run(name, params, cids) {
      // A list that a line cannot hold is refused before the request is sent, so the view never receives it.
      let carried;
      try {
        carried = causeCids(cids);
      } catch (error) {
        return Promise.reject(error);
      }
      return calls.request(name, params, { cids: carried });
    },
    receive(event) {
      if (!deliver) throw new Error(`view command reply ${event.id} arrived after the surface closed`);
      const { surface, plugin: owner, ...reply } = event;
      deliver(reply);
    },
    close() {
      deliver = null;
      calls.peerLost("surface-closed");
    },
  };
}
