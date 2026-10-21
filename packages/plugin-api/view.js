// The view side of the view channel (docs/plans/plugin-processes.md, rule 4). A view page runs on sok://<plugin id>. The
// injected document-start script (view-start.js) posts the ready message, checks each host message, and keeps the host
// messages until a listener attaches; this module reads them through window.sokView.attach and sends through the handler
// of the view (the sok-view webkit message handler in the application).
//
// The module imports nothing under runtime/ and no @soksak/workbench/ specifier, so the core root serves it to a view with
// the view import map (rule 4). Its imports are the call layer, the snapshot channel and the recording functions of a plugin
// runtime, which import nothing else.

import { createCalls } from "./calls.js";
import { createPluginRuntime } from "./plugin-runtime.js";
import { createSnapshotSender, SNAPSHOT_ACK_EVENT, SNAPSHOT_REQUEST_COMMAND } from "./snapshots.js";

const PLUGIN = /^[a-z][a-z0-9-]*$/;
/** The code of a command that the view did not register: EXPOSURE_ERRORS.unregistered of index.js, which this module does not import. */
const UNREGISTERED_COMMAND = 1002;
/** The code of a command that failed: EXPOSURE_ERRORS.failed of index.js. */
const FAILED_COMMAND = -32000;
/** The code of a request whose parameters are invalid: EXPOSURE_ERRORS.invalidParams of index.js, which this module does not import. */
const INVALID_PARAMS = -32602;

/** Runs a command handler and settles with the reply payload {result} or {error: {code, message}}, as the exposure relay expects. */
async function runCommand(run, params) {
  try {
    // default: an undefined result of a command without a result is answered as null.
    return { result: (await run(params)) ?? null };
  } catch (error) {
    // default: a thrown value that is not an Error carries its value as the message.
    return { error: { code: FAILED_COMMAND, message: String(error?.message ?? error) } };
  }
}

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
 * Returns {calls, snapshots}. runtime serves the context entries of the view page: native.on, sidecar().on and .onFailure,
 * theme, and textSize and settings with read and on each.
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
  // The stored levels of a record of the plugin, which the page tells at the first use of runtime.log and at each change
  // (docs/spec/native-surfaces.md#view-surfaces). Until the first answer every record is sent, and the level gate of the page
  // counts what it does not store, so no record is lost before the levels are known.
  let levels = null;
  let levelsRequested = false;
  const storedLevel = (level) => {
    if (!levelsRequested) {
      levelsRequested = true;
      if (!listeners.has("log.levels")) listeners.set("log.levels", new Set());
      listeners.get("log.levels").add((next) => { levels = next; });
      calls.request("runtime.log.levels", null).then((next) => { levels = next; }, (error) => {
        // A refused read leaves every record sent, and the refusal is recorded as an error of the view.
        // default: a refusal that is not an Error carries its value as the text.
        runtime.error("log levels", String(error?.message ?? error)).catch(() => {
          // silent: the error line of the refusal is itself refused, and the view has no other path to the application log.
        });
      });
    }
    return levels === null || levels.includes(level);
  };
  // The prefix that the page adds to the event of a plugin record; the call carries the event without it.
  const prefix = `plugin.${plugin}.`;
  const { log } = createPluginRuntime({ pluginId: plugin, hooks: {
    log: (level, event, fields, cids) => {
      calls.request("runtime.log", { level, event: event.slice(prefix.length), fields, ...(cids === undefined ? {} : { cids }) })
        .catch((error) => {
          // default: a refusal that is not an Error carries its value as the text.
          runtime.error(`log ${event}`, String(error?.message ?? error)).catch(() => {
            // silent: the error line of the refusal is itself refused, and the view has no other path to the application log.
          });
        });
    },
    logEnabled: storedLevel,
  } });
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
    // The scale of the surface and the settings of the plugin: read reads the current value, and on registers one listener
    // under the one subscription of its key, which the page registers once (docs/spec/native-surfaces.md#view-surfaces).
    textSize: {
      read: () => calls.request("runtime.textSize.read", null),
      on: (listener) => listen("textSize", () => calls.request("runtime.textSize.on", null), listener),
    },
    settings: {
      read: () => calls.request("runtime.settings.read", null),
      on: (listener) => listen("settings", () => calls.request("runtime.settings.on", null), listener),
    },
    // The event log of the page: log.<level>(event, fields, {cids}) and log.enabled(level), as runtime.log of the surface context.
    log,
    // The error line of an error that the view shows on its own page: the page writes `surface <surface> <where>: <text>` to the
    // application log at the moment the view shows it (docs/spec/native-surfaces.md#view-surfaces).
    error: (where, text) => calls.request("runtime.error", { where, text }).then(() => undefined),
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
    if (message.event === "theme" || message.event === "textSize" || message.event === "settings" || message.event === "log.levels") {
      return message.event;
    }
    if (message.event === "sidecar.message" || message.event === "sidecar.failure") return `${message.event}:${message.data?.id}`;
    return `native:${message.event}`;
  };
  // The command handlers of the view by command name, registered through commands.register.
  const handlers = new Map();
  const commands = {
    /**
     * Declares a command of the view: the page applies the declaration through the exposure registry, and each request of the command
     * runs run(params). The handler is kept before the declaration is sent, so a request that follows the reply finds it. A refused
     * declaration removes the handler and rejects with the error of the page.
     */
    register(name, run) {
      if (typeof name !== "string" || name === "") throw new TypeError("commands.register requires a non-empty name");
      if (typeof run !== "function") throw new TypeError(`commands.register requires a function for ${name}`);
      handlers.set(name, run);
      return calls.request("runtime.command.register", { name }).then(() => undefined, (error) => {
        handlers.delete(name);
        throw error;
      });
    },
  };
  // The pull of the current value of a status (docs/plans/plugin-processes.md, rule 2 and messages and events): the reply is
  // {seq, value}, with seq 0 and value null when the source has no value yet.
  const answerSnapshotRequest = (request) => {
    const status = request.params?.status;
    if (typeof status !== "string" || status === "") {
      channel.send({ sok: 1, reply: request.id, error: { code: INVALID_PARAMS, message: "declared-ui.snapshot.request requires a status name" } });
      return;
    }
    // default: a status without a value is not an error of the pull; the reply says that the source has none yet.
    let value;
    try {
      value = snapshots.pull(status);
    } catch {
      value = { seq: 0, value: null };
    }
    channel.send({ sok: 1, reply: request.id, result: value });
  };
  // A request of the page for a command of the view is answered with {sok: 1, reply: id, result} or {sok: 1, reply: id, error}.
  // A command that the view did not register is refused with the unregistered code of the exposure errors (docs/plans/plugin-processes.md, rule 3).
  const answerRequest = (request) => {
    if (!Number.isInteger(request.id)) throw new TypeError("command request has no integer id");
    if (request.command === SNAPSHOT_REQUEST_COMMAND) {
      answerSnapshotRequest(request);
      return;
    }
    const run = handlers.get(request.command);
    const reply = run
      ? runCommand(run, request.params)
      : Promise.resolve({ error: { code: UNREGISTERED_COMMAND, message: `view command ${request.command} is not registered` } });
    reply.then((payload) => channel.send({ sok: 1, reply: request.id, ...payload }));
  };
  const dispatch = (message) => {
    if (message.event === "theme") lastTheme = message.data;
    // default: an event that no listener has has no listener to pass it to, so it is passed to none.
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
  // The exposure of the page: status and dom registrations go through the channel, and the reply to a forwarded exposure
  // request carries the id of that request (docs/spec/exposure.md#relay, docs/spec/native-surfaces.md#view-surfaces).
  const exposure = {
    register: (kind, name) => calls.request("runtime.native.call", { name: "registered", payload: { kind, name } }),
    reply: (id, payload) => calls.request("runtime.native.call", { name: "exposureReply", payload: { id, ...payload } }),
  };
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
      // The acknowledgement arrives as the view event declared-ui.snapshot.ack with {plugin, status, seq} as its data
      // (docs/spec/native-surfaces.md#view-surfaces, view events).
      onAcknowledgement({ event: SNAPSHOT_ACK_EVENT, ...message.data });
      return;
    }
    if (typeof message.event === "string") {
      dispatch(message);
      return;
    }
    if (typeof message.command === "string") {
      answerRequest(message);
      return;
    }
    if (!onCall) throw new Error(`view channel for ${plugin} has no call layer`);
    onCall(message);
  });
  /**
   * The connected items of the extension point point that the plugin declares (docs/spec/plugins.md#extension-points), each
   * {plugin, index, item, module, fail(reason)}; module is the URL on the core root. fail makes that item invalid through the page
   * and leaves the other items connected; an Error reason carries its message.
   */
  const contributions = (point) => calls.request("runtime.contributions", { point }).then((items) => items.map((entry) => Object.freeze({
    ...entry,
    fail: (reason) => calls.request("runtime.contributions.fail", {
      point, plugin: entry.plugin, index: entry.index, reason: reason instanceof Error ? reason.message : String(reason),
    }).then(() => undefined),
  })));
  return { calls, snapshots, runtime, commands, exposure, contributions };
}
