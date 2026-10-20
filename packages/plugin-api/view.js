// The view side of the view channel (docs/plans/plugin-processes.md, rule 4). A view page runs on sok://<plugin id>. The
// injected document-start script (view-start.js) posts the ready message, checks each host message, and keeps the host
// messages until a listener attaches; this module reads them through window.sokView.attach and sends through the handler
// of the view (the sok-view webkit message handler in the application).
//
// The module imports nothing under runtime/ and no @soksak/workbench/ specifier, so the core root serves it to a view with
// the view import map (rule 4). Its imports are the call layer and the snapshot channel, which import nothing else.

import { createCalls } from "./calls.js";
import { createSnapshotSender, SNAPSHOT_ACK_EVENT } from "./snapshots.js";

const PLUGIN = /^[a-z][a-z0-9-]*$/;

/** The plugin id of the view: the host of the sok:// origin of the page. */
function pluginOfView() {
  const plugin = window.location.host;
  if (!PLUGIN.test(plugin)) throw new Error(`view channel requires a view page on sok://<plugin id>, got ${window.location.href}`);
  return plugin;
}

/**
 * Creates the channel of one view page.
 *
 *     handler     an object with postMessage(message), the sok-view message handler of the view
 *
 * Returns {send, onMessage}.
 *
 *     send(message)        posts the message through the handler; throws when the handler throws
 *     onMessage(listener)  attaches the one listener of the host messages through window.sokView.attach. The host messages
 *                          that the injected script kept before the attach are passed in order, then each later one.
 *
 * Throws when the injected script is not loaded, because the host messages are read only through window.sokView.
 */
export function createViewChannel({ handler }) {
  if (typeof handler?.postMessage !== "function") throw new TypeError("createViewChannel requires a handler with postMessage");
  if (typeof window.sokView?.attach !== "function") throw new Error("the view channel script is not loaded");
  return {
    send(message) {
      handler.postMessage(message);
    },
    onMessage(listener) {
      window.sokView.attach(listener);
    },
  };
}

/**
 * Creates the calls and the declared UI snapshots of a view over one view channel. The calls are createCalls() and the snapshot
 * sender is createSnapshotSender(), both sending through the channel. The channel has one listener, which passes each
 * acknowledgement of a snapshot to the sender and every other message to the calls.
 *
 *     handler   the sok-view message handler of the view, as for createViewChannel
 *     report    report(event) receives the counts and losses of the calls and the snapshots, as createCalls and createSnapshotSender
 *
 * Returns {calls, snapshots}.
 */
export function createViewBridge({ handler, report }) {
  if (typeof report !== "function") throw new TypeError("createViewBridge requires the report function");
  const plugin = pluginOfView();
  const channel = createViewChannel({ handler });
  let onCall = null;
  let onAcknowledgement = null;
  // A call message carries the sok marker, which the host reads as a call request of the view (docs/spec/native-surfaces.md#view-surfaces).
  const calls = createCalls({
    plugin,
    send: (message) => channel.send({ sok: 1, ...message }),
    onMessage: (next) => {
      onCall = next;
      return () => {
        onCall = null;
      };
    },
    report,
  });
  const snapshots = createSnapshotSender({
    plugin,
    send: channel.send,
    onMessage: (next) => {
      onAcknowledgement = next;
      return () => {
        onAcknowledgement = null;
      };
    },
    report,
  });
  channel.onMessage((message) => {
    if (message.event === SNAPSHOT_ACK_EVENT) {
      if (!onAcknowledgement) throw new Error(`view channel for ${plugin} has no snapshot layer`);
      onAcknowledgement(message);
      return;
    }
    if (!onCall) throw new Error(`view channel for ${plugin} has no call layer`);
    onCall(message);
  });
  return { calls, snapshots };
}
