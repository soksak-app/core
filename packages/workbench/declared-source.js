// The declared UI snapshot transport of the main page (docs/spec/declared-ui.md, status mapping;
// docs/spec/plugin-host.md#declared-ui-snapshots). The host relays each snapshot of a view as the event
// declared-ui-snapshot of the window; the page acknowledges a snapshot as the view event declared-ui.snapshot.ack and pulls
// the current value of a status through the command layer of the view. The source of a plugin host carries no surface: the
// host relays its snapshots without a surface field, the page acknowledges through the pluginHostEvent host call, and the
// pull runs declared-ui.snapshot.request through the pluginHostRequest host call (plugin-host.js).
import { host as bridge } from "@soksak/runtime";
import { SNAPSHOT_EVENT, SNAPSHOT_REQUEST_COMMAND } from "@soksak/plugin-api";
import { viewCommandsOf } from "./view-commands.js";
import { hostCommandsOf, pluginOfHostKey } from "./plugin-host.js";

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
  function subscribe(event, matches, receive) {
    let closed = false;
    let registration;
    try {
      registration = bridge.on(event, (message) => {
        if (matches(message)) receive(message);
      });
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(registration).then((unsubscribe) => {
      if (typeof unsubscribe !== "function") throw new TypeError(`${where}: snapshot listener registration did not return an unsubscribe function`);
      if (closed) {
        unsubscribe();
        return () => {};
      }
      return () => {
        closed = true;
        unsubscribe();
      };
    }, (error) => {
      closed = true;
      throw error;
    });
  }
  return {
    channel(source) {
      if (source.surface === null) {
        // The transport of a plugin host source (docs/spec/plugin-host.md#declared-ui-snapshots). The snapshot of a host
        // carries no surface, and the acknowledgement goes to the host page through pluginHostEvent.
        return {
          send: (message) => bridge.call("pluginHostEvent", { plugin, event: message.event, data: { plugin: message.plugin, status: message.status, seq: message.seq } })
            .catch((error) => dispatchEvent(new ErrorEvent("error", { message: `${where}: ${error.message}` }))),
          onMessage: (receive) => {
            return subscribe("declared-ui-snapshot", (event) => event?.plugin === plugin && event?.surface === undefined, (event) => {
              receive({ event: SNAPSHOT_EVENT, plugin, status: event.status, seq: event.seq, value: event.value, skipped: event.skipped });
            });
          },
        };
      }
      return {
        // The acknowledgement is the view event declared-ui.snapshot.ack of the surface, whose data carries {plugin, status, seq}
        // (docs/spec/native-surfaces.md#view-surfaces, declared UI snapshots). A refusal of the host is reported through the page
        // errors, as for every view event push.
        send: (message) => bridge.call("viewEvent", { surface: source.surface, event: message.event, data: { plugin: message.plugin, status: message.status, seq: message.seq } })
          .catch((error) => dispatchEvent(new ErrorEvent("error", { message: `${where}: ${error.message}` }))),
        onMessage: (receive) => {
          return subscribe("declared-ui-snapshot", (event) => event?.surface === source.surface && event?.plugin === plugin, (event) => {
            receive({ event: SNAPSHOT_EVENT, plugin, status: event.status, seq: event.seq, value: event.value, skipped: event.skipped });
          });
        },
      };
    },
    expanded(source, request) {
      const data = { status, tree: request.tree, path: request.path, expanded: request.expanded };
      if (source.surface === null) {
        return bridge.call("pluginHostEvent", { plugin, event: "declared-ui.expanded", data });
      }
      return bridge.call("viewEvent", { surface: source.surface, event: "declared-ui.expanded", data });
    },
    pull(source) {
      if (source.surface === null) {
        // The pull of a plugin host source runs through the request layer of its channel (plugin-host.js).
        const host = hostCommandsOf(pluginOfHostKey(source.id));
        if (host === null) return Promise.reject(new Error(`${where}: the plugin host has no channel`));
        return host.run(SNAPSHOT_REQUEST_COMMAND, { status });
      }
      const layer = viewCommandsOf(source.surface);
      if (layer === null) return Promise.reject(new Error(`${where}: surface ${source.surface} has no view command layer`));
      return layer.run(SNAPSHOT_REQUEST_COMMAND, { status });
    },
  };
}
