// The view side of the view channel (docs/spec/plugin-processes.md, rule 4). A view page runs on soksak://<plugin id>. The
// injected document-start script (view-start.js) posts the ready message, checks each host message, and keeps the host
// messages until a listener attaches; this module reads them through window.sokView.attach and sends through the handler
// of the view (the sok-view webkit message handler in the application).
//
// The module imports nothing under runtime/ and no @soksak/workbench/ specifier, so the core root serves it to a view with
// the view import map (rule 4). Its imports are the call layer, the plugin runtime and the composition controller with its
// region handles, which import nothing else.

import { causeCids, createCalls } from "./calls.js";
import { createOperationCids } from "./operation.js";
import { createPluginRuntime } from "./plugin-runtime.js";
import { createEventBatcher } from "./log-batch.js";
import { createSurfaceCompositionController } from "./surface-composition.js";
import { applyTheme, createExpose } from "./index.js";
import { observeSurfaceDocument, surfaceDocumentEntry } from "./surface-document.js";
import { focusedExposure } from "./focus.js";

const PLUGIN = /^[a-z][a-z0-9-]*$/;
/** A binary id of the binary store of a document: 32 lowercase hexadecimal characters (docs/spec/plugin-processes.md#binary-path). */
const BINARY_ID = /^[0-9a-f]{32}$/;
/** The code of a command that the view did not register: EXPOSURE_ERRORS.unregistered of index.js, which this module does not import. */
const UNREGISTERED_COMMAND = 1002;
/** The code of a command that failed: EXPOSURE_ERRORS.failed of index.js. */
const FAILED_COMMAND = -32000;
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

/** The plugin id of the view: the host of the soksak:// origin of the page. */
function pluginOfView() {
  const plugin = window.location.host;
  if (!PLUGIN.test(plugin)) throw new Error(`view channel requires a view page on soksak://<plugin id>, got ${window.location.href}`);
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
 * Creates the report function of createViewBridge for a view page. An error report, a call that ended by a timeout and a peer that
 * was lost for another reason than a closed surface reach reportError, which the view page passes as its global error hook, so the
 * start script of the view writes them to the application log. The open-call counts are console debug records, and a call that
 * ended because its surface closed is a console info record.
 */
export function createViewReporter({ reportError, console }) {
  if (typeof reportError !== "function") throw new TypeError("createViewReporter requires reportError");
  if (typeof console?.debug !== "function" || typeof console?.info !== "function") {
    throw new TypeError("createViewReporter requires console debug and info methods");
  }
  return (event) => {
    if (event?.kind === "open-calls") {
      console.debug("view bridge open calls", event);
      return;
    }
    if (event?.kind === "peer-lost" && event.reason === "surface-closed") {
      console.info("view bridge closed call", event);
      return;
    }
    const fields = [];
    if (typeof event?.where === "string") fields.push(event.where);
    if (typeof event?.text === "string") fields.push(event.text);
    // default: a thrown value that is not an Error is named by its text.
    if (event?.error !== undefined) fields.push(`report error: ${event.error?.message ?? String(event.error)}`);
    const message = fields.length > 0
      ? fields.join(": ")
      : `view bridge ${typeof event?.kind === "string" ? event.kind : "report"}: ${JSON.stringify(event)}`;
    reportError(new Error(message));
  };
}

/** The key of a status watch of the view: a watch of a name on a surface is apart from the watch of the name on another surface. */
// default: a watch without a surface is the watch of the name on the workbench, keyed by null.
const statusKey = (name, surface) => `status:${JSON.stringify([name, surface ?? null])}`;

/** Refuses a project data call whose key is not a non-empty text (docs/spec/plugins.md#project-data). */
function requireDataKey(command, key) {
  if (typeof key !== "string" || key === "") throw new TypeError(`${command} requires a non-empty key`);
}

/**
 * Creates the calls of a view over one view channel. The calls are createCalls(), sending through the channel. The channel has one
 * listener, which passes every message to the calls.
 *
 *     handler   the sok-view message handler of the view, as for createViewChannel
 *     report    report(event) receives the counts and losses of the calls, as createCalls reports them; a view page passes createViewReporter()
 *
 * Returns {calls, runtime, commands, exposure, contributions, composition}. runtime serves the context entries of the view page: native.on, sidecar(name).on, .onFailure and .send,
 * theme, status.watch, data.get and data.set, textSize and settings with read and on each, and clipboard with read, writeText and persistPNG. composition.create({regions, overlays})
 * creates the composition of the declared regions of the view (docs/spec/native-surfaces.md#view-surfaces, regions).
 */
export function createViewBridge({ handler, report }) {
  if (typeof report !== "function") throw new TypeError("createViewBridge requires the report function");
  const plugin = pluginOfView();
  // A view does not inherit the stylesheet of the main page, so the bridge sets the theme of the start script on the root of the
  // view document before any page script draws, and each later theme message in dispatch (docs/spec/native-surfaces.md#view-surfaces).
  if (window.sokTheme === undefined) throw new Error(`view ${plugin} has no start theme`);
  applyTheme(window.document.documentElement, window.sokTheme);
  const channel = createViewChannel({ handler });
  let onCall = null;
  let onCoreExposure = null;
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
    // A listener whose subscription is refused is removed with it, so the refused listener receives no event.
    return subscriptions.get(key).then(() => () => {
      listeners.get(key)?.delete(listener);
    }, (error) => {
      listeners.get(key)?.delete(listener);
      throw error;
    });
  };
  const subscribe = (name) => calls.request("runtime.native.on", { name });
  // The stored level of each class: the start value of the surface, then the data of each notice log.levels.
  let levels = window.sokSurface?.levels;
  let levelsWatched = false;
  const readLevels = () => {
    if (levels === undefined) throw new Error(`view ${plugin} has no start levels`);
    if (!levelsWatched) {
      levelsWatched = true;
      listen("log.levels", () => calls.request("runtime.log.levels.on", null), (data) => { levels = data; })
        .catch(recordError("log levels"));
    }
    return levels;
  };
  // The status watches of the view: one page subscription per name and surface, and each listener of the watch receives the value of the
  // status. A refused watch removes its listeners and records the refusal as an error line of the view; the stop function ends the watch
  // when no listener of the watch remains (docs/spec/native-surfaces.md#view-surfaces, view events).
  const watchStatus = (name, listener, { surface } = {}) => {
    if (typeof name !== "string" || name === "") throw new TypeError("runtime.status.watch requires a non-empty name");
    if (typeof listener !== "function") throw new TypeError("runtime.status.watch requires a listener");
    if (surface !== undefined && (typeof surface !== "string" || surface === "")) {
      throw new TypeError("runtime.status.watch requires a non-empty surface");
    }
    const key = statusKey(name, surface);
    // The call names the surface only when the watch has one, so a watch of the workbench is the same call as before.
    const params = surface === undefined ? { name } : { name, surface };
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(listener);
    if (!subscriptions.has(key)) {
      const pending = calls.request("runtime.status.watch", params);
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
      calls.request("runtime.status.unwatch", params).catch(recordError(`status ${name}`));
    };
  };
  // Records the refusal of a call that the view makes on its own as an error line of the view at the place where.
  const recordError = (where) => (error) => {
    // default: a refusal that is not an Error carries its value as the text.
    const text = String(error?.message ?? error);
    // A refused error line is reported through the bridge's report, which the page writes to the application log.
    runtime.error(where, text).catch((failure) => report({ where, text, error: failure }));
  };
  // The identifiers of the operations that start in this view page (docs/spec/logging.md#operation-chains).
  const nextOperationCids = createOperationCids(window.sokView.page);
  let batcher = null;
  const writeLog = (level, event, fields, cids) => {
    if (batcher === null) {
      batcher = createEventBatcher({
        call: (request) => calls.request("runtime.log", request),
        report: recordError("log batch"),
        now: () => window.performance.now(),
        writer: { layer: "page", member: "page", identity: window.sokView.page },
      });
      batcher.emit("info", "page.start", { time_origin: window.sokView.timeOrigin, url: window.location.href });
    }
    // events: forwarded
    batcher.emit(level, event, fields, cids);
  };
  const { log } = createPluginRuntime({ pluginId: plugin, hooks: {
    log: (level, event, fields, cids) => writeLog(level, event, fields, cids),
  } });
  // The binary path of the view (docs/spec/plugin-processes.md#binary-path): an upload stores bytes in the binary store of the view
  // document and answers their id, and a download returns the bytes of an id and releases it. A refusal answers {error}.
  const uploadBinary = async (bytes, type) => {
    const response = await window.fetch(`soksak://${plugin}/.binary`, { method: "POST", headers: { "Content-Type": type }, body: bytes });
    const answer = await response.json();
    if (!response.ok) throw new Error(`binary upload failed with ${response.status}: ${answer.error}`);
    if (!BINARY_ID.test(answer.id)) throw new Error(`binary upload answered no binary id: ${JSON.stringify(answer)}`);
    return answer.id;
  };
  const downloadBinary = async (id) => {
    const response = await window.fetch(`soksak://${plugin}/.binary/${id}`);
    if (!response.ok) throw new Error(`binary download of ${id} failed with ${response.status}: ${(await response.json()).error}`);
    return new Uint8Array(await response.arrayBuffer());
  };
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
    // The value of a status of the plugin or of core (docs/spec/native-surfaces.md#view-surfaces, view events). watch(name, listener, {surface})
    // follows the status on the surface that the options name, or on the workbench when they name none, and returns the function that ends
    // the watch of the listener. surface is a surface of the plugin of the view that the window holds, such as a section surface
    // (docs/spec/plugins.md#sections).
    status: {
      watch: watchStatus,
    },
    // The project data of the plugin for the project of the view (docs/spec/plugins.md#project-data): get(key) resolves with the stored
    // value or the default, and set(key, value) resolves with null after the store accepted the write. on(listener) registers listener({key})
    // for each change of a key, by a view of this window or by another window, under one subscription of the page.
    data: {
      on: (listener) => listen("data", () => calls.request("runtime.data.on", null), listener),
      get: (key) => {
        requireDataKey("runtime.data.get", key);
        return calls.request("runtime.data.get", { key });
      },
      set: (key, value) => {
        requireDataKey("runtime.data.set", key);
        return calls.request("runtime.data.set", { key, value });
      },
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
    // The clipboard of the view page (docs/spec/native-surfaces.md#view-surfaces, view calls). read returns what the clipboard bridge of
    // a surface context returns: the text, the file URLs or the PNG bytes, or null when the clipboard holds no payload of the type. A PNG
    // travels through the binary path: a png read downloads the bytes of the id that the reply names, and persistPNG uploads the bytes
    // and sends their id.
    clipboard: Object.freeze({
      read: async (type) => {
        const reply = await calls.request("runtime.clipboard.read", type);
        if (type !== "png" || reply === null) return reply;
        if (reply?.present !== true || reply.type !== "png" || !BINARY_ID.test(reply.binary)) {
          throw new Error(`clipboard png reply is invalid: ${JSON.stringify(reply)}`);
        }
        return downloadBinary(reply.binary);
      },
      writeText: (text) => calls.request("runtime.clipboard.writeText", text).then(() => undefined),
      persistPNG: async (value) => {
        if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
          throw new TypeError("persistPNG requires the PNG bytes as a Uint8Array or an ArrayBuffer");
        }
        const binary = await uploadBinary(value instanceof ArrayBuffer ? new Uint8Array(value) : value, "image/png");
        const persisted = await calls.request("runtime.clipboard.persistPNG", { binary });
        if (typeof persisted?.path !== "string" || typeof persisted.shellQuotedPath !== "string") {
          throw new Error(`clipboard PNG persistence reply is invalid: ${JSON.stringify(persisted)}`);
        }
        return { path: persisted.path, shellQuotedPath: persisted.shellQuotedPath };
      },
    }),
    // The event log of the page: log.<level>(event, fields, {cids}), as runtime.log of the surface context. levels() returns the stored
    // level of each class, the start value levels until the first notice log.levels and the levels of the last notice after it; the
    // page reads it only to skip building data that the writer would not store (docs/spec/native-surfaces.md#view-surfaces). The first
    // read subscribes the page to the notices.
    log: Object.freeze({ ...log, levels: readLevels }),
    // The error line of an error that the view shows on its own page: the page writes `surface <surface> <where>: <text>` to the
    // application log at the moment the view shows it (docs/spec/native-surfaces.md#view-surfaces).
    error: (where, text) => calls.request("runtime.error", { where, text }).then(() => undefined),
    // The one route of a view to run a command that core or the view declares (docs/spec/native-surfaces.md#view-surfaces, input).
    // The call layer keeps the owner check of each name; the bridge adds no set of names.
    // The options carry cids, the identifiers of the operation that the command belongs to; a command without them has none.
    // surface names the surface of the plugin that runs a command of the plugin, as a section view runs it on the surface that it
    // follows; the call is then runtime.command.run (docs/spec/native-surfaces.md#view-surfaces, view calls).
    command: (name, params = null, { cids, surface } = {}) => {
      if (typeof name !== "string" || name === "") throw new TypeError("runtime.command requires a non-empty name");
      if (surface === undefined) return calls.request(name, params, { cids: causeCids(cids) });
      if (typeof surface !== "string" || surface === "") throw new TypeError("runtime.command requires a non-empty surface");
      return calls.request("runtime.command.run", { name, params, surface }, { cids: causeCids(cids) });
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
  };
  // The key of the listeners of a host event: a sidecar event has the session id in its data, and a theme has one key.
  const keyOf = (message) => {
    if (["theme", "textSize", "settings", "data", "log.levels"].includes(message.event)) {
      return message.event;
    }
    if (message.event === "sidecar.message" || message.event === "sidecar.failure") return `${message.event}:${message.data?.id}`;
    if (message.event === "status") return statusKey(message.data?.name, message.data?.surface);
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
  // A request of the page for a command of the view is answered with {sok: 1, reply: id, result} or {sok: 1, reply: id, error}.
  // A command that the view did not register is refused with the unregistered code of the exposure errors (docs/spec/plugin-processes.md, rule 3).
  const answerRequest = (request) => {
    if (!Number.isInteger(request.id)) throw new TypeError("command request has no integer id");
    const run = handlers.get(request.command);
    // The context of the handler holds the cids of the cause of the request, and no cids member when the request has none.
    const context = request.cids === undefined ? {} : { cids: request.cids };
    const reply = run
      ? runCommand(run, request.params, context)
      : Promise.resolve({ error: { code: UNREGISTERED_COMMAND, message: `view command ${request.command} is not registered` } });
    reply.then((payload) => channel.send({ sok: 1, reply: request.id, ...payload }));
  };
  const dispatch = (message) => {
    // An idle document renders a new size at once and then waits for the display, so the second size of a run misses a frame.
    // A frame requested at the start of a run makes the first size wait for the display like every later size.
    if (message.event === "run-start") {
      window.requestAnimationFrame(() => {});
      return;
    }
    if (message.event === "exposure-request" && surfaceDocumentEntry(message.data?.params?.name)) {
      if (!onCoreExposure) throw new Error(`view ${plugin} has no core document exposure handler`);
      onCoreExposure(message.data);
      return;
    }
    if (message.event === "theme") {
      lastTheme = message.data;
      applyTheme(window.document.documentElement, lastTheme);
    }
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
  // The exposure of the page: status and element registrations go through the channel, and the reply to a forwarded exposure
  // request carries the id of that request (docs/spec/exposure.md#relay, docs/spec/native-surfaces.md#view-surfaces).
  // The port has no unregister. The registrations of a view end with the view: the host removes them when the surface closes
  // (exposure-registered with closed, docs/spec/exposure.md#relay) and when the view process ends (docs/spec/native-surfaces.md,
  // process end). The spec defines no call that removes a registration while the view stays open, and the allowed calls of a view
  // are registered and changed (view exposure) and exposureReply (plugin host calls) in docs/spec/native-surfaces.md. So the dispose of a view
  // exposure ends only the local request listener, bindings and declarations. Each value of a watched status goes to the page as
  // changed {name, value, version} (docs/spec/exposure.md#relay).
  const exposure = {
    register: (kind, name) => calls.request("runtime.native.call", { name: "registered", payload: { kind, name } }),
    reply: (id, payload) => calls.request("runtime.native.call", { name: "exposureReply", payload: { id, ...payload } }),
    changed: (name, value, version) => calls.request("runtime.native.call", { name: "changed", payload: { name, value, version } }),
  };
  channel.onMessage((message) => {
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
  // Only a surface document, which has window.sokSurface, owns these entries.
  if (window.sokSurface !== undefined) {
    const view = window;
    const state = observeSurfaceDocument(view);
    const expose = createExpose({
      register: exposure.register,
      reply: exposure.reply,
      changed: exposure.changed,
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
    // The focused exposed element of the view document goes to the page with the view call tab.focus at each change; the page
    // combines it with the first responder of the window in core.focus (docs/spec/exposure.md#keyboard-focus). A move between
    // two elements fires focusout before focusin, so the value is read once after the move.
    let reportedFocus = "null";
    let focusRead = false;
    const readFocus = () => {
      focusRead = false;
      const value = focusedExposure(view.document);
      const text = JSON.stringify(value);
      if (text === reportedFocus) return;
      reportedFocus = text;
      calls.request("tab.focus", value).catch(recordError("tab focus"));
    };
    const focusMoved = () => {
      if (focusRead) return;
      focusRead = true;
      queueMicrotask(readFocus);
    };
    view.document.addEventListener("focusin", focusMoved, true);
    view.document.addEventListener("focusout", focusMoved, true);
    // A right click opens the surface menu through the page (docs/spec/native-surfaces.md#view-surfaces, view calls): the default
    // menu of the web view holds operations, such as Reload, that no command declares. A right click that the plugin cancelled is its own.
    const openMenu = (event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      calls.request("surface.menu", { x: event.clientX, y: event.clientY }).catch(recordError("surface menu"));
    };
    view.addEventListener("contextmenu", openMenu);
    view.addEventListener("pagehide", () => {
      if (batcher !== null) batcher.flush().catch(recordError("log batch flush"));
      view.document.removeEventListener("focusin", focusMoved, true);
      view.document.removeEventListener("focusout", focusMoved, true);
      view.removeEventListener("contextmenu", openMenu);
      state.dispose();
      expose.dispose().catch(recordError("core surface entries"));
    }, { once: true });
  }
  return { calls, runtime, commands, exposure, contributions, composition };
}
