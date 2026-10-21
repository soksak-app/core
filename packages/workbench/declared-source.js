// The declared UI snapshot transport of the main page (docs/spec/declared-ui.md, status mapping;
// docs/plans/plugin-processes.md, rule 2). The host relays each snapshot of a view as the event declared-ui.snapshot of the
// window; the page acknowledges a snapshot as the view event declared-ui.snapshot.ack and pulls the current value of a status
// through the command layer of the view. A source without a view (a plugin host) has no transport yet: its channel is null and
// its pull finds no value, and its section stays cleared (docs/spec/declared-ui.md, status mapping).
import { host as bridge } from "@soksak/runtime";
import { SNAPSHOT_EVENT, SNAPSHOT_REQUEST_COMMAND } from "@soksak/plugin-api";
import { viewCommandsOf } from "./view-commands.js";

/**
 * Creates the transport of one declared status of plugin.
 *
 *     plugin   the plugin id that owns the status
 *     status   the name of the status in the plugin
 *
 * Returns {channel, pull}.
 *
 *     channel(source)  the {send, onMessage} of the snapshot channel of a view source, or null for a source without a view.
 *                      onMessage delivers each snapshot of the surface of the source as a snapshot message and returns the
 *                      unsubscribe function; send acknowledges one snapshot through the view event of the surface.
 *     pull(source)     a promise of the pull reply {seq, value} of a view source, and of {seq: 0, value: null} for a source
 *                      without a view, whose transport does not exist yet.
 */
export function createDeclaredSource({ plugin, status }) {
  if (typeof plugin !== "string" || plugin === "") throw new TypeError("the declared source requires the plugin id");
  if (typeof status !== "string" || status === "") throw new TypeError(`the declared source of ${plugin} requires a status name`);
  const where = `${plugin}.${status}`;
  return {
    channel(source) {
      if (source.surface === null) return null;
      return {
        // The acknowledgement is the view event declared-ui.snapshot.ack of the surface, whose data carries {plugin, status, seq}
        // (docs/spec/native-surfaces.md#view-surfaces, declared UI snapshots). A refusal of the host is reported through the page
        // errors, as for every view event push.
        send: (message) => bridge.call("viewEvent", { surface: source.surface, event: message.event, data: { plugin: message.plugin, status: message.status, seq: message.seq } })
          .catch((error) => dispatchEvent(new ErrorEvent("error", { message: `${where}: ${error.message}` }))),
        onMessage: (receive) => {
          let unsubscribe = null;
          let closed = false;
          // The registration of a runtime listener is asynchronous; the unsubscribe ends it as soon as it is registered.
          Promise.resolve(bridge.on("declared-ui.snapshot", (event) => {
            if (event?.surface !== source.surface || event?.plugin !== plugin) return;
            receive({ event: SNAPSHOT_EVENT, plugin, status: event.status, seq: event.seq, value: event.value, skipped: event.skipped });
          })).then((off) => {
            if (closed) off();
            else unsubscribe = off;
          }, (error) => {
            dispatchEvent(new ErrorEvent("error", { message: `${where}: ${error.message}` }));
          });
          return () => {
            closed = true;
            // default: an unsubscribe before the registration completed ends nothing here; the registration ends itself.
            unsubscribe?.();
          };
        },
      };
    },
    pull(source) {
      if (source.surface === null) return Promise.resolve({ seq: 0, value: null });
      const layer = viewCommandsOf(source.surface);
      if (layer === null) return Promise.reject(new Error(`${where}: surface ${source.surface} has no view command layer`));
      return layer.run(SNAPSHOT_REQUEST_COMMAND, { status });
    },
  };
}
