// The view side of the view channel (docs/spec/plugin-processes.md, rule 4). A view page runs on sok://<plugin id>. The
// injected document-start script (view-start.js) posts the ready message, checks each host message, and keeps the host
// messages until a listener attaches; this module reads them through window.sokView.attach and sends through the handler
// of the view (the sok-view webkit message handler in the application).
//
// The module imports nothing under runtime/ and no @soksak/workbench/ specifier, so the core root serves it to a view with
// the view import map (rule 4). Its imports are the call layer, the snapshot channel, the plugin runtime and the composition
// controller with its region handles, which import nothing else.

import { causeCids, createCalls } from "./calls.js";
import { createOperationCids } from "./operation.js";
import { createPluginRuntime } from "./plugin-runtime.js";
import { createSnapshotSender, SNAPSHOT_ACK_EVENT, SNAPSHOT_REQUEST_COMMAND } from "./snapshots.js";
import { createSurfaceCompositionController } from "./surface-composition.js";
import { createExpose } from "./index.js";
import { observeSurfaceDocument, surfaceDocumentEntry } from "./surface-document.js";

const PLUGIN = /^[a-z][a-z0-9-]*$/;
/** The code of a command that the view did not register: EXPOSURE_ERRORS.unregistered of index.js, which this module does not import. */
const UNREGISTERED_COMMAND = 1002;
/** The code of a command that failed: EXPOSURE_ERRORS.failed of index.js. */
const FAILED_COMMAND = -32000;
/** The code of a request whose parameters are invalid: EXPOSURE_ERRORS.invalidParams of index.js, which this module does not import. */
const INVALID_PARAMS = -32602;
/** Runs a command handler with its params and its context and settles with the reply payload {result} or {error: {code, message}}, as the exposure relay expects. */
async function runCommand(run, params, context) {
  try {
    // default: an undefined result of a command without a result is answered as null.
    return { result: (await run(params, context)) ?? null };
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
 * Returns {calls, snapshots}. runtime serves the context entries of the view page: native.on, sidecar(name).on, .onFailure and .send,
 * theme, and textSize and settings with read and on each. composition.create({regions, overlays}) creates the composition of the
 * declared regions of the view (docs/spec/native-surfaces.md#view-surfaces, regions).
 */
export function createViewBridge({ handler, report }) {
  if (typeof report !== "function") throw new TypeError("createViewBridge requires the report function");
  const plugin = pluginOfView();
  const channel = createViewChannel({ handler });
  let onCall = null;
  let onAcknowledgement = null;
  let onCoreExposure = null;
  // The listeners of the view by key (see keyOf), and the last theme that the host sent. A key has one subscription call on the
  // page, made by its first listener; a theme has none, because the host sends it.
  const listeners = new Map();
  const subscriptions = new Map();
  let lastTheme;
  // The last project of the window that the host sent to a plugin host page; undefined until the host sends one.
  let lastProject;
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
    // A listener whose subscription is refused is removed with it, so the refused listener receives no event.
    return subscriptions.get(key).then(() => () => {
      listeners.get(key)?.delete(listener);
    }, (error) => {
      listeners.get(key)?.delete(listener);
      throw error;
    });
  };
  const subscribe = (name) => calls.request("runtime.native.on", { name });
  // The status watches of the view: one page subscription per name, and each listener of the name receives the value of the status.
  // A refused watch removes its listeners and records the refusal as an error line of the view; the stop function ends the watch when
  // no listener of the name remains (docs/spec/native-surfaces.md#view-surfaces, view events).
  const watchStatus = (name, listener) => {
    if (typeof name !== "string" || name === "") throw new TypeError("runtime.status.watch requires a non-empty name");
    if (typeof listener !== "function") throw new TypeError("runtime.status.watch requires a listener");
    const key = `status:${name}`;
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(listener);
    if (!subscriptions.has(key)) {
      const pending = calls.request("runtime.status.watch", { name });
      subscriptions.set(key, pending);
      pending.catch((error) => {
        if (subscriptions.get(key) !== pending) return;
        subscriptions.delete(key);
        listeners.delete(key);
        recordError(`status ${name}`)(error);
      });
    }
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      const set = listeners.get(key);
      set?.delete(listener);
      if (set && set.size > 0) return;
      listeners.delete(key);
      subscriptions.delete(key);
      calls.request("runtime.status.unwatch", { name }).catch(recordError(`status ${name}`));
    };
  };
  // Records the refusal of a call that the view makes on its own as an error line of the view at the place where.
  const recordError = (where) => (error) => {
    // default: a refusal that is not an Error carries its value as the text.
    const text = String(error?.message ?? error);
    // A refused error line is reported through the bridge's report, which the page writes to the application log.
    runtime.error(where, text).catch((failure) => report({ where, text, error: failure }));
  };
  // The prefix that the page adds to the event of a plugin record; the call carries the event without it.
  const prefix = `plugin.${plugin}.`;
  // The identifiers of the operations that start in this view page (docs/spec/logging.md#operation-chains).
  const nextOperationCids = createOperationCids();
  const { log } = createPluginRuntime({ pluginId: plugin, hooks: {
    log: (level, event, fields, cids) => {
      calls.request("runtime.log", { level, event: event.slice(prefix.length), fields, ...(cids === undefined ? {} : { cids }) })
        .catch(recordError(`log ${event}`));
    },
  } });
  const runtime = {
    native: {
      on: (name, listener) => {
        if (typeof name !== "string" || name === "") throw new TypeError("runtime.native.on requires a non-empty name");
        return listen(`native:${name}`, () => subscribe(name), listener);
      },
    },
    // The sidecar is named by the view, and each request carries the name with the session id (docs/plans/plugin-host-routes.md rule 4).
    sidecar: (name) => {
      if (typeof name !== "string" || name === "") throw new TypeError("runtime.sidecar requires a sidecar name");
      return {
        on: (id, listener) => listen(`sidecar.message:${id}`, () => calls.request("runtime.sidecar.on", { id, sidecar: name }), (data) => listener(data.body)),
        onFailure: (id, listener) => listen(`sidecar.failure:${id}`, () => calls.request("runtime.sidecar.onFailure", { id, sidecar: name }), (data) => listener(data.reason)),
        // default: cids is optional; without it the send carries no correlation identifiers.
        send: (id, body, cids = []) => calls.request("runtime.sidecar.send", { id, sidecar: name, body, cids }),
      };
    },
    // The value of a status of the plugin or of core (docs/spec/native-surfaces.md#view-surfaces, view events): watch(name, listener)
    // returns the function that ends the watch of the listener.
    status: {
      watch: watchStatus,
    },
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
    // The event log of the page: log.<level>(event, fields, {cids}), as runtime.log of the surface context. The page has no level query.
    log,
    // The error line of an error that the view shows on its own page: the page writes `surface <surface> <where>: <text>` to the
    // application log at the moment the view shows it (docs/spec/native-surfaces.md#view-surfaces).
    error: (where, text) => calls.request("runtime.error", { where, text }).then(() => undefined),
    // The one route of a view to run a command that core or the view declares (docs/spec/native-surfaces.md#view-surfaces, input).
    // The call layer keeps the owner check of each name; the bridge adds no set of names.
    // The options carry cids, the identifiers of the operation that the command belongs to; a command without them has none.
    command: (name, params = null, { cids } = {}) => {
      if (typeof name !== "string" || name === "") throw new TypeError("runtime.command requires a non-empty name");
      return calls.request(name, params, { cids: causeCids(cids) });
    },
    // Starts an operation of this view (docs/spec/native-surfaces.md#view-surfaces): the identifier is assigned in the page's form,
    // the first event is stored through runtime.log with it, and the list is returned for the calls that carry the operation out.
    beginOperation: (event, fields = {}) => {
      if (typeof event !== "string" || event === "") throw new TypeError("runtime.beginOperation requires an event name");
      const cids = nextOperationCids();
      log.info(event, fields, { cids });
      return cids;
    },
    theme: (listener) => {
      if (typeof listener !== "function") throw new TypeError("runtime.theme requires a listener");
      if (!listeners.has("theme")) listeners.set("theme", new Set());
      listeners.get("theme").add(listener);
      // The listener gets the last theme at once, so a theme that arrived before the listener is not lost.
      if (lastTheme !== undefined) listener(lastTheme);
      return { ready: Promise.resolve(), dispose: Promise.resolve(() => listeners.get("theme")?.delete(listener)) };
    },
    // The project that the window shows reaches a plugin host page as the project message, as the theme does (docs/spec/plugin-host.md).
    // The listener gets the last project at once, and a null project is a value of its own.
    project: (listener) => {
      if (typeof listener !== "function") throw new TypeError("runtime.project requires a listener");
      if (!listeners.has("project")) listeners.set("project", new Set());
      listeners.get("project").add(listener);
      if (lastProject !== undefined) listener(lastProject);
      return { ready: Promise.resolve(), dispose: Promise.resolve(() => listeners.get("project")?.delete(listener)) };
    },
  };
  // The key of the listeners of a host event: a sidecar event has the session id in its data, and a theme has one key.
  const keyOf = (message) => {
    if (message.event === "theme" || message.event === "project" || message.event === "textSize" || message.event === "settings" || message.event === "log.levels") {
      return message.event;
    }
    if (message.event === "sidecar.message" || message.event === "sidecar.failure") return `${message.event}:${message.data?.id}`;
    if (message.event === "status") return `status:${message.data?.name}`;
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
  // The pull of the current value of a status (docs/spec/plugin-processes.md, rule 2 and messages and events): the reply is
  // {seq, value}, with seq 0 and value null when the source has no value yet.
  const answerSnapshotRequest = (request) => {
    const status = request.params?.status;
    if (typeof status !== "string" || status === "") {
      channel.send({ sok: 1, reply: request.id, error: { code: INVALID_PARAMS, message: "declared-ui.snapshot.request requires a status name" } });
      return;
    }
    // A status with no pushed value is not an error of the pull: the reply says that the source has none yet, with seq 0 and value null
    // (docs/spec/declared-ui.md, pull). Any other error of the store answers the request with its error and is reported.
    if (!snapshots.has(status)) {
      channel.send({ sok: 1, reply: request.id, result: { seq: 0, value: null } });
      return;
    }
    let value;
    try {
      value = snapshots.pull(status);
    } catch (error) {
      // default: a thrown value that is not an Error carries its value as the text.
      const text = String(error?.message ?? error);
      report({ where: `declared-ui.snapshot.request ${status}`, text });
      channel.send({ sok: 1, reply: request.id, error: { code: FAILED_COMMAND, message: text } });
      return;
    }
    channel.send({ sok: 1, reply: request.id, result: value });
  };
  // A request of the page for a command of the view is answered with {sok: 1, reply: id, result} or {sok: 1, reply: id, error}.
  // A command that the view did not register is refused with the unregistered code of the exposure errors (docs/spec/plugin-processes.md, rule 3).
  const answerRequest = (request) => {
    if (!Number.isInteger(request.id)) throw new TypeError("command request has no integer id");
    if (request.command === SNAPSHOT_REQUEST_COMMAND) {
      answerSnapshotRequest(request);
      return;
    }
    const run = handlers.get(request.command);
    // The context of the handler holds the cids of the cause of the request, and no cids member when the request has none.
    const context = request.cids === undefined ? {} : { cids: request.cids };
    const reply = run
      ? runCommand(run, request.params, context)
      : Promise.resolve({ error: { code: UNREGISTERED_COMMAND, message: `view command ${request.command} is not registered` } });
    reply.then((payload) => channel.send({ sok: 1, reply: request.id, ...payload }));
  };
  const dispatch = (message) => {
    if (message.event === "exposure-request" && surfaceDocumentEntry(message.data?.params?.name)) {
      if (!onCoreExposure) throw new Error(`view ${plugin} has no core document exposure handler`);
      onCoreExposure(message.data);
      return;
    }
    if (message.event === "theme") lastTheme = message.data;
    if (message.event === "project") lastProject = message.data;
    // A status value reaches its listeners as the value, without the name that keys the event.
    const data = message.event === "status" ? message.data.value : message.data;
    // default: an event that no listener has has no listener to pass it to, so it is passed to none.
    for (const listener of [...(listeners.get(keyOf(message)) ?? [])]) listener(data);
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
  // The port has no unregister. The registrations of a view end with the view: the host removes them when the surface closes
  // (exposure-registered with closed, docs/spec/exposure.md#relay) and when the view process ends (docs/spec/native-surfaces.md,
  // process end). The spec defines no call that removes a registration while the view stays open, and the allowed calls of a view
  // are registered (view exposure) and exposureReply (plugin host calls) in docs/spec/native-surfaces.md. So the dispose of a view exposure ends only
  // the local request listener, bindings and declarations.
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
  // The port of the composition controller: each region operation is a view call that the main page runs with the page operations
  // of the surface, and each region event arrives through runtime.native.on (docs/spec/native-surfaces.md#view-surfaces, regions).
  const port = {
    surfaces: { report: (message) => calls.request("composition.report", message) },
    composition: {
      // The main page numbers the placement with the composition revision of its document, so the revision of the view is not sent.
      place: (_revision, regions, overlays) => calls.request("composition.place", { regions, overlays }),
    },
    document: {
      attach: (name) => calls.request("document.attach", { name }),
      load: (name, url) => calls.request("document.load", { name, url }),
      zoom: (name, zoom) => calls.request("document.zoom", { name, zoom }),
      go: (name, action, offset) => calls.request("document.go", offset === undefined ? { name, action } : { name, action, offset }),
      post: (name, message) => calls.request("document.post", { name, message }),
      subscribe: (name, stream) => calls.request("document.subscribe", { name, stream }),
      unsubscribe: (name, handle) => calls.request("document.unsubscribe", { name, handle }),
      detach: (name) => calls.request("document.detach", { name }),
      onState: (listener) => runtime.native.on("document-state", (event) => listener(event.document, event.state)),
      onMessage: (listener) => runtime.native.on("document-message", (event) => listener(event.document, event.message)),
      onStream: (listener) => runtime.native.on("document-stream", (event) => listener(event.document, event.handle, event.message)),
    },
    image: {
      attach: (name, sidecar) => calls.request("image.attach", { name, sidecar }),
      focus: (name) => calls.request("image.focus", { name }),
      caret: (name, x, y, width, height) => calls.request("image.caret", { name, x, y, width, height }),
      text: (name, text) => calls.request("image.text", { name, text }),
      detach: (name) => calls.request("image.detach", { name }),
      on: (listener) => runtime.native.on("image-event", (event) => listener(event.name, event.event)),
    },
  };
  const composition = {
    /**
     * Creates the composition of the declared regions and overlays of the view from elements of the view document, as
     * createSurfaceComposition does for a page. The insets are measured against the viewport of the view, which is the view frame.
     */
    async create({ regions = {}, overlays = {} } = {}) {
      const declaration = await calls.request("composition.declaration", null);
      return createSurfaceCompositionController(port, declaration, { regions, overlays }, window);
    },
  };
  // A plugin host uses this bridge too but has no surface start values. Only a surface document owns these entries.
  if (window.sokSurface !== undefined) {
    const view = window;
    const state = observeSurfaceDocument(view);
    const expose = createExpose({
      register: exposure.register,
      reply: exposure.reply,
      report: (text) => runtime.error("core surface entries", text),
      onRequest: async (answer) => {
        onCoreExposure = answer;
        // One native subscription is shared with plugin listeners; dispatch above reserves the core document requests.
        const stop = await runtime.native.on("exposure-request", () => {});
        return () => { onCoreExposure = null; stop(); };
      },
    }, () => view.sokSurface.declarations);
    Promise.all([
      expose.status("core.surface.document", state.document.read, state.document.subscribe),
      expose.status("core.surface.input", state.input.read, state.input.subscribe),
      expose.command("core.surface.hit", state.hit),
    ]).catch(recordError("core surface entries"));
    view.addEventListener("pagehide", () => {
      state.dispose();
      expose.dispose().catch(recordError("core surface entries"));
    }, { once: true });
  }
  return { calls, snapshots, runtime, commands, exposure, contributions, composition };
}
