// The page side of the commands of a view (docs/spec/native-surfaces.md#view-surfaces). The page runs a command of a view for each
// exposure request of the command: it sends {id, command, params} to the view as viewRequest, and the view answers with the reply
// that the host delivers as view-reply. The call layer of plugin-api holds the open calls, their declared time limit and the late
// replies, so the requests use the same rules as the calls of a plugin process (docs/plans/plugin-processes.md, rule 3).

import { createCalls, DEFAULT_CALL_TIMEOUT } from "@soksak/plugin-api";

/** The code of a command that failed: EXPOSURE_ERRORS.failed of plugin-api. */
const FAILED_COMMAND = -32000;

// The command layer of each view surface, by surface id. The answers of a surface keep its layer here, so every sender of a
// command of the view (the exposure requests and the declared UI pull) sends through one layer, and each reply of the surface
// reaches one layer.
const layers = new Map();

/** Keeps the command layer of the view of surfaceId and returns the function that removes it. */
export function keepViewCommands(surfaceId, commands) {
  layers.set(surfaceId, commands);
  return () => {
    if (layers.get(surfaceId) === commands) layers.delete(surfaceId);
  };
}

/** The command layer of the view of surfaceId, or null while its answers are not connected. */
export function viewCommandsOf(surfaceId) {
  return layers.get(surfaceId) ?? null;
}

/**
 * Creates the command layer of one view surface.
 *
 *     plugin      the plugin id of the view
 *     post        post(message): sends {id, command, params} to the view through viewRequest; rejects when the host refuses it
 *     timeoutOf   timeoutOf(name): the declared time limit of the command, or undefined when it declares none
 *     report      report(event): receives the timeouts and late replies of the calls, as createCalls reports them
 *
 * Returns {run, receive, close}. run(name, params) resolves with the result of the view, or rejects with its error. receive(event)
 * takes a view-reply event {surface, plugin, id, result} or {surface, plugin, id, error}. close() ends every open call with surface-closed.
 */
export function createViewCommands({ plugin, post, timeoutOf, report }) {
  if (typeof post !== "function" || typeof timeoutOf !== "function" || typeof report !== "function") {
    throw new TypeError("createViewCommands requires the post, timeoutOf and report functions");
  }
  // The listener of the call layer, which receive() delivers the replies of the view to. It is null after close().
  let deliver = null;
  const calls = createCalls({
    plugin,
    send: (message) => {
      // The call layer sends synchronously. A refusal of the host is a reply of the call, so the call ends with the refusal text.
      post(message).catch((error) => {
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
    run(name, params) {
      // default: a command that declares no time limit waits for the default time limit of the call layer (docs/spec/exposure.md).
      return calls.request(name, params, { timeout: timeoutOf(name) ?? DEFAULT_CALL_TIMEOUT });
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
