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
  // The listeners of the view by key (see keyOf), and the last theme that the host sent. A key has one subscription call on the
  // page, made by its first listener; a theme has none, because the host sends it.
  const listeners = new Map();
  const subscriptions = new Map();
  let lastTheme;
  const listen = (key, call, listener) => {
    if (typeof listener !== "function") throw new TypeError(`${key} requires a listener`);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(listener);
    if (!subscriptions.has(key)) {
      const pending = call();
      subscriptions.set(key, pending);
      // A refused subscription is forgotten, so that a later listener of the key subscribes again.
      pending.catch(() => subscriptions.delete(key));
    }
    return subscriptions.get(key).then(() => () => {
      listeners.get(key)?.delete(listener);
    });
  };
  const subscribe = (name) => calls.request("runtime.native.on", { name });
  const runtime = {
    native: {
      on: (name, listener) => {
        if (typeof name !== "string" || name === "") throw new TypeError("runtime.native.on requires a non-empty name");
        return listen(`native:${name}`, () => subscribe(name), listener);
      },
    },
    sidecar: () => ({
      on: (id, listener) => listen(`sidecar.message:${id}`, () => calls.request("runtime.sidecar.on", { id }), (data) => listener(data.body)),
      onFailure: (id, listener) => listen(`sidecar.failure:${id}`, () => calls.request("runtime.sidecar.onFailure", { id }), (data) => listener(data.reason)),
    }),
    theme: (listener) => {
      if (typeof listener !== "function") throw new TypeError("runtime.theme requires a listener");
      if (!listeners.has("theme")) listeners.set("theme", new Set());
      listeners.get("theme").add(listener);
      // The listener gets the last theme at once, so a theme that arrived before the listener is not lost.
      if (lastTheme !== undefined) listener(lastTheme);
      return { ready: Promise.resolve(), dispose: Promise.resolve(() => listeners.get("theme")?.delete(listener)) };
    },
  };
  // The key of the listeners of a host event: a sidecar event has the session id in its data, and a theme has one key.
  const keyOf = (message) => {
    if (message.event === "theme") return "theme";
    if (message.event === "sidecar.message" || message.event === "sidecar.failure") return `${message.event}:${message.data?.id}`;
    return `native:${message.event}`;
  };
  const dispatch = (message) => {
    if (message.event === "theme") lastTheme = message.data;
    for (const listener of [...(listeners.get(keyOf(message)) ?? [])]) listener(message.data);
  };
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
    if (typeof message.event === "string") {
      dispatch(message);
      return;
    }
    if (!onCall) throw new Error(`view channel for ${plugin} has no call layer`);
    onCall(message);
  });
  return { calls, snapshots, runtime };
}
