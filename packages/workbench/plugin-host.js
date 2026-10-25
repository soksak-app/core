// The page side of the plugin host channel (docs/spec/plugin-host.md#channel). The host relays each call request of a host
// page as the event plugin-host-call of the main page, and the main page answers it with the pluginHostReply host call; the
// host serves only the registration calls of exposure and refuses every other command. The requests of the main page to a
// host page, such as the pull of a declared status, go through the pluginHostRequest host call, and the page answers them
// as replies that the host relays as the events plugin-host-reply.

import { host as bridge } from "@soksak/runtime";
import { errorText } from "./error-text.js";
import { reportRecord } from "./page-log.js";
import { createViewCommands } from "./view-commands.js";
import { callReporter } from "./plugin-processes.js";
import { runCommandCall } from "./command-route.js";
import { registerSourceOrigin, sourceOrigin } from "./source-origins.js";
import { startDeclaredSnapshotIngress } from "./declared-source.js";

/** The code of a command that failed: EXPOSURE_ERRORS.failed of plugin-api. */
const FAILED_COMMAND = -32000;

/** The place of a listing error: a non-empty string without a control character and without ": " (the check of the view call runtime.error). */
const ERROR_PLACE = /^(?!.*: )[^\u0000-\u001f\u007f]+$/;

/** The key that a plugin host registers under, from its plugin id (docs/spec/plugin-host.md#exposure). */
export const hostKeyOf = (plugin) => `plugin:${plugin}`;

/** The plugin of a host key, or null for a key that is not one. */
export const pluginOfHostKey = (key) => (typeof key === "string" && key.startsWith("plugin:") ? key.slice("plugin:".length) : null);

/**
 * The plugin and sidecar of a plugin session id plugin:<plugin id>:<project id>:<sidecar name>, or null for an id that is
 * not one (docs/plans/plugin-host-routes.md rule 2). No id contains a colon, so the split is unambiguous.
 */
export function pluginSessionOf(id) {
  if (typeof id !== "string" || !id.startsWith("plugin:")) return null;
  const parts = id.split(":");
  if (parts.length !== 4 || parts.some((part) => part === "")) return null;
  return { plugin: parts[1], project: parts[2], sidecar: parts[3] };
}

/**
 * Checks a sidecar request of a plugin host on the main page (docs/plans/plugin-host-routes.md rule 8). declared lists the
 * operations that the plugin manifest declares for the sidecar (hostOperations); sidecarDeclaration is the validated
 * sidecar.json, whose message form the body takes and whose hostReadOperations allow the operation. Returns the object that
 * the host call forwards to the sidecar as the body, in the json-object form; throws a named error otherwise.
 */
export function checkHostSidecarRequest({ plugin, sidecar, declared = [], sidecarDeclaration, body }) {
  const refuse = (reason) => new Error(`plugin host ${plugin}: ${reason}`);
  const form = sidecarDeclaration?.message;
  if (form === undefined) throw refuse(`sidecar ${sidecar} declares no message form`);
  // The body is the JSON object that the page sends (the json-object form of docs/spec/sidecars.md); a text is not an object.
  const object = body;
  if (typeof object !== "object" || object === null || Array.isArray(object)) throw refuse("body is not a JSON object");
  const operation = object[form.operationField];
  if (typeof operation !== "string") throw refuse("operation is missing or not a string");
  // default: hostReadOperations is an optional field of sidecar.json; without it the sidecar allows no operation to a plugin host.
  const readable = sidecarDeclaration.hostReadOperations ?? [];
  if (!declared.includes(operation) || !readable.includes(operation)) throw refuse(`operation ${operation} is not served`);
  return object;
}

/** The served calls of the channel of a plugin host (docs/spec/plugin-host.md#channel). */
export const servedPluginHostCall = (command) => command === "runtime.command.register" || command === "page.exposure.register"
  || command === "runtime.sidecar.send" || command === "runtime.sidecar.on" || command === "runtime.sidecar.onFailure"
  || command === "runtime.data.get" || command === "runtime.data.set" || command === "runtime.error"
  || command === "runtime.command" || command === "runtime.log" || command === "runtime.native.on" || command === "runtime.native.call";

/**
 * The exposure requests of the host pages (docs/spec/plugin-host.md#channel). A host page subscribes to exposure-request with
 * runtime.native.on; a dom request of an entry that the host registered is delivered to it as the message event exposure-request
 * and is answered by runtime.native.call exposureReply (docs/spec/exposure.md#relay).
 */
const exposureSubscribers = new Set();
const exposureReplies = new Map();
let nextExposureId = 0;
// The wait of a host for the answer to an exposure request, in milliseconds (docs/spec/exposure.md#relay). A timer is the only bound
// of the wait: the host page sends no event when it stops answering.
const EXPOSURE_REPLY_TIMEOUT = 10000;

/** Removes the exposure subscription of plugin and ends each of its open exposure requests with an error (plugin-host-ended). */
function forgetExposure(plugin) {
  exposureSubscribers.delete(plugin);
  for (const [id, pending] of [...exposureReplies]) {
    if (pending.plugin !== plugin) continue;
    exposureReplies.delete(id);
    pending.resolve({ error: { code: FAILED_COMMAND, message: `plugin host ${plugin} ended before it answered` } });
  }
}

/**
 * Forwards one dom request of an entry that the host of plugin registered to its host page and resolves with the reply
 * {result} or {error: {code, message}} that the page sends. It rejects when the page has no exposure-request subscription.
 */
export function forwardHostExposure(plugin, method, params) {
  if (!exposureSubscribers.has(plugin)) return Promise.reject(new Error(`plugin host ${plugin} has no exposure-request subscription`));
  const generation = hostCommandGeneration(plugin);
  if (generation === null) return Promise.reject(new Error(`plugin host ${plugin} has no current source generation`));
  const id = ++nextExposureId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      exposureReplies.delete(id);
      reject(new Error(`plugin host ${plugin} did not answer ${method} within ${EXPOSURE_REPLY_TIMEOUT} ms`));
    }, EXPOSURE_REPLY_TIMEOUT);
    exposureReplies.set(id, {
      plugin,
      resolve: (reply) => { clearTimeout(timer); resolve(reply); },
    });
    bridge.call("pluginHostEvent", { plugin, generation, event: "exposure-request", data: { id, method, params } }).catch((error) => {
      clearTimeout(timer);
      exposureReplies.delete(id);
      // default: a rejection that is not an Error is reported by its text.
      reject(new Error(errorText(error)));
    });
  });
}

/** Delivers the page's reply to an exposure request of plugin, which must be open for that plugin. */
function answerExposure(plugin, payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload) || !Number.isInteger(payload.id)) {
    throw new TypeError("plugin host call runtime.native.call exposureReply requires an integer id");
  }
  const pending = exposureReplies.get(payload.id);
  if (pending === undefined || pending.plugin !== plugin) {
    throw new Error(`plugin host ${plugin} answered no open exposure request ${payload.id}`);
  }
  exposureReplies.delete(payload.id);
  if (payload.error !== undefined) {
    pending.resolve({ error: payload.error });
    return null;
  }
  if (!Object.hasOwn(payload, "result")) throw new TypeError("plugin host call runtime.native.call exposureReply requires a result or an error");
  pending.resolve({ result: payload.result });
  return null;
}

// The levels of a record of a plugin, in the order the view call runtime.log names them (docs/spec/plugin-host.md#log-call).
const PLUGIN_LOG_LEVELS = ["error", "warn", "info", "debug", "trace"];

/*
 * The sidecars that each installed plugin declares as dependencies: plugin id -> [{name, declared, declaration}]. declared is the
 * operations that the plugin manifest names for the sidecar (hostOperations), and declaration is the validated sidecar.json, or null
 * when the page holds none. The installed document carries the facts of each sidecar dependency, so the sidecar check refuses every
 * operation of a sidecar that the document holds no facts for (docs/plans/plugin-host-routes.md rule 8).
 */
const declaredSidecars = new Map();

/** Records the sidecars that a plugin declares for its plugin host (docs/plans/plugin-host-routes.md rule 8). */
export function declarePluginSidecars(plugin, sidecars) {
  declaredSidecars.set(plugin, sidecars);
}

/** The sidecars that a plugin declares for its plugin host. default: a plugin that declared none has no sidecars (an empty list). */
export const pluginSidecarsOf = (plugin) => declaredSidecars.get(plugin) ?? [];

/*
 * The sessions of the sidecars that each plugin host subscribed to: plugin -> session id -> the event kinds (message, failure)
 * that the host page listens to. A reply to a session with no subscription of its kind is dropped (docs/plans/plugin-host-routes.md
 * rule 4), so the page subscribes before its first send.
 */
const sessions = new Map();

function subscribeSession(plugin, session, kind) {
  let kinds = sessions.get(plugin);
  if (!kinds) sessions.set(plugin, kinds = new Map());
  let set = kinds.get(session);
  if (!set) kinds.set(session, set = new Set());
  set.add(kind);
}

/** Removes every session subscription of plugin, which ends with its host (plugin-host-ended). */
export function forgetSessions(plugin) {
  sessions.delete(plugin);
}

/** The page-side route of a sidecar event of a plugin session: it posts the event to the host page of its plugin. */
function routeSessionEvent(kind, event, sidecar, session, payload) {
  const plugin = pluginSessionOf(session)?.plugin;
  const subscribed = sessions.get(plugin)?.get(session)?.has(kind) === true;
  if (!subscribed) {
    // default: a sidecar event with no subscription of its kind is a loss, written at warn (docs/spec/logging.md).
    reportRecord("warn", `plugin host ${plugin}: sidecar ${sidecar} ${kind} for ${session} dropped: no subscription`);
    return;
  }
  const fields = kind === "message" ? { body: payload } : { reason: payload };
  const generation = hostCommandGeneration(plugin);
  if (generation === null) {
    reportRecord("error", `plugin host ${plugin}: sidecar event ${kind} for ${session} not delivered: no current source generation`);
    return;
  }
  // The event is the sidecar event of the view channel (sidecar.message, sidecar.failure) with the session id in its data, which the
  // page listens to by the id (view-bridge keyOf). The host posts it as the message {sok, event, data}, which requires the data.
  // default: a post that the host refuses is written at error with its reason.
  bridge.call("pluginHostEvent", { plugin, generation, event: `sidecar.${kind}`, data: { sidecar, id: session, ...fields } }).catch((error) => {
    // default: a rejection that is not an Error is reported by its text, so the record names the failure either way.
    reportRecord("error", `plugin host ${plugin}: sidecar event ${kind} for ${session} not delivered: ${errorText(error)}`);
  });
}

// The sidecar listeners of the page, installed once when a host first subscribes to a session.
let sessionListeners = null;
function listenSessionEvents() {
  // default: the listeners are installed on the first subscription and kept after it, so the assignment runs once.
  sessionListeners ??= Promise.all([
    bridge.on("sidecar-message", (event) => {
      if (pluginSessionOf(event?.surface) !== null) routeSessionEvent("message", event, event.sidecar, event.surface, event.body);
    }),
    bridge.on("sidecar-failure", (event) => {
      if (pluginSessionOf(event?.surface) !== null) routeSessionEvent("failure", event, event.sidecar, event.surface, event.reason);
    }),
  ]);
  return sessionListeners;
}

// The command layer of each plugin host, by plugin id. The answers of a host keep its layer here, so every sender of a
// request to the host (the exposure requests and the declared UI pull) sends through one layer, and each reply of the host
// reaches one layer.
const layers = new Map();
const layerGenerations = new Map();

/** Keeps the command layer of the host of plugin and returns the function that removes it. */
export function keepHostCommands(plugin, commands, generation) {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError("plugin host command layer requires a positive source generation");
  const previous = layers.get(plugin);
  if (previous && previous !== commands) previous.close();
  layers.set(plugin, commands);
  layerGenerations.set(plugin, generation);
  return () => {
    if (layers.get(plugin) === commands) {
      layers.delete(plugin);
      layerGenerations.delete(plugin);
    }
  };
}

/** The command layer of the host of plugin, or null while its answers are not connected. */
export function hostCommandsOf(plugin) {
  // default: a host whose answers are not connected has no layer, and its reader treats null as no request path.
  return layers.get(plugin) ?? null;
}

/** The generation of the command layer of plugin, or null while it has no layer. */
export function hostCommandGeneration(plugin) {
  return layerGenerations.get(plugin) ?? null; // default: a host without an active command layer has no generation.
}

/**
 * Creates the command layer of one plugin host. run(name, params) posts {id, command, params} to the host through
 * pluginHostRequest and resolves with the reply that arrives as the plugin-host-reply event of the plugin; receive(event)
 * takes such an event. close() ends every open call of the host with surface-closed.
 */
export function createHostCommands({ plugin, generation, timeoutOf }) {
  if (typeof timeoutOf !== "function") throw new TypeError("createHostCommands requires the timeoutOf function");
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError("createHostCommands requires a positive source generation");
  const commands = createViewCommands({
    plugin,
    post: (message) => bridge.call("pluginHostRequest", { plugin, generation, id: message.id, command: message.command, params: message.params }),
    timeoutOf,
    // The call records of the host are the statuses of the plugin (open calls, losses), as the calls of a view are; none is an error.
    report: callReporter(plugin),
  });
  return {
    run: commands.run,
    receive(event) {
      if (event.generation !== generation || sourceOrigin(plugin, null) !== generation) return false;
      // The reply of a host page names no surface; receive of the view layer drops it with the plugin.
      commands.receive({ surface: undefined, ...event });
      return true;
    },
    close: commands.close,
  };
}

/**
 * Answers the calls of the plugin hosts of the window and keeps their layers connected. The served call of a command keeps
 * the command layer of the plugin and registers the command with the owner key plugin:<plugin id>; the served registration
 * of an exposure entry registers the entry under the same key (docs/spec/plugin-host.md#exposure). register(plugin, kind,
 * name) registers one entry of the host of plugin in the registry of this document; unregister(plugin) removes every entry
 * of the host when the host sends plugin-host-ended, which also ends the open requests of this document to the host with
 * surface-closed (docs/spec/plugin-host.md#channel); timeoutOf(name) is the declared time limit of a command; report(error)
 * receives the failures of a registration or an answer.
 *
 * Returns {receive(event), close()}. receive takes one plugin-host-call event; close() ends the subscription and every open
 * call of every host with surface-closed.
 */
export function listenPluginHostCalls({ register, unregister, timeoutOf, report, displayError, sidecarsOf = () => [], projectData = null, runCore, runOwned, pluginLog }) {
  if ([register, unregister, timeoutOf, report, displayError, sidecarsOf, runCore, runOwned, pluginLog].some((value) => typeof value !== "function")) {
    throw new TypeError("listenPluginHostCalls requires the register, unregister, timeoutOf, report, displayError, sidecarsOf, runCore, runOwned and pluginLog functions");
  }
  // The declared sidecar of the plugin named by a request, with the operations its host may call (rule 8). default: a plugin
  // with no sidecarsOf entries declares none, so every sidecar request of its host is refused by name.
  const ownedLayers = new Map();
  const declaredSidecar = (plugin, name) => {
    const sidecar = sidecarsOf(plugin).find((entry) => entry.name === name);
    if (!sidecar) throw new Error(`plugin host ${plugin} cannot use sidecar ${name}`);
    return sidecar;
  };
  const answerSidecar = async (event, params) => {
    const { plugin } = event;
    if (typeof params.sidecar !== "string" || params.sidecar === "") throw new TypeError(`plugin host call ${event.command} requires a sidecar name`);
    const declared = declaredSidecar(plugin, params.sidecar);
    const session = pluginSessionOf(params.id);
    if (session === null || session.plugin !== plugin || session.sidecar !== params.sidecar) {
      throw new Error(`plugin host ${plugin} cannot use sidecar session ${params.id}`);
    }
    if (event.command === "runtime.sidecar.on" || event.command === "runtime.sidecar.onFailure") {
      // The subscription is recorded before the reply, so a reply of the sidecar that follows the answer is delivered.
      subscribeSession(plugin, params.id, event.command === "runtime.sidecar.on" ? "message" : "failure");
      await listenSessionEvents();
      return { result: null };
    }
    const body = checkHostSidecarRequest({ plugin, sidecar: params.sidecar, declared: declared.declared, sidecarDeclaration: declared.declaration, body: params.body });
    await listenSessionEvents();
    await bridge.call("pluginHostSidecarSend", { plugin, sidecar: params.sidecar, id: params.id, body, cids: params.cids });
    return { result: null };
  };
  // The project data calls of a plugin host are answered by the project data of the shown project (docs/spec/plugin-host.md#project-data-calls).
  const answerData = async (event, params) => {
    const { plugin } = event;
    if (projectData === null) throw new Error(`plugin host ${plugin}: project data is not connected`);
    if (typeof params.key !== "string" || params.key === "") throw new TypeError(`plugin host call ${event.command} requires a key`);
    if (event.command === "runtime.data.get") return { result: await projectData.get(plugin, params.key) };
    if (!Object.hasOwn(params, "value")) throw new TypeError(`plugin host call ${event.command} requires a value`);
    await projectData.set(plugin, params.key, params.value);
    return { result: null };
  };
  const answer = async (event) => {
    const { plugin, id } = event;
    try {
      if (!servedPluginHostCall(event.command)) {
        throw new Error(`plugin host call ${event.command} is not served`);
      }
      // default: a call without params is a call with no arguments, as a command run without params is.
      const params = event.params ?? {};
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw new TypeError(`plugin host call ${event.command} requires an object`);
      }
      // The first served call of a host keeps its command layer, through which the requests of this document run and the
      // replies of the page return.
      let commands = hostCommandsOf(plugin);
      if (commands === null || hostCommandGeneration(plugin) !== event.generation) {
        commands = createHostCommands({ plugin, generation: event.generation, timeoutOf });
        keepHostCommands(plugin, commands, event.generation);
        ownedLayers.set(plugin, commands);
      }
      if (event.command === "runtime.error") {
        // The listing error of the host page is written through the error display of the main page; the declared tree draws no error (docs/spec/plugin-host.md#channel).
        if (typeof params.where !== "string" || !ERROR_PLACE.test(params.where)) {
          throw new TypeError(`plugin host call ${event.command} requires a non-empty where without a control character or ": "`);
        }
        if (typeof params.text !== "string" || params.text === "") throw new TypeError(`plugin host call ${event.command} requires a non-empty text`);
        displayError(`plugin ${plugin} ${params.where}: ${params.text}`);
        return { result: null };
      }
      if (event.command === "runtime.command") {
        // The command call runs with the owner checks of the view call (docs/spec/plugin-host.md#command-call).
        if (typeof params.name !== "string" || params.name === "") throw new TypeError(`plugin host call ${event.command} requires a non-empty name`);
        // default: a command call without params runs the command with null, the value of no params.
        return { result: await runCommandCall(params.name, params.params ?? null, { call: "plugin host call", plugin, runCore, runOwned }) };
      }
      if (event.command === "runtime.log") {
        // The log call writes the record through the log of the plugin context, with the checks of that log (docs/spec/plugin-host.md#log-call).
        if (!PLUGIN_LOG_LEVELS.includes(params.level)) throw new TypeError(`plugin host call ${event.command} log level must be one of ${PLUGIN_LOG_LEVELS.join(", ")}`);
        pluginLog(plugin)[params.level](params.event, params.fields, params.cids === undefined ? undefined : { cids: params.cids });
        return { result: null };
      }
      if (event.command === "runtime.native.on") {
        // Host pages subscribe only to exposure relay and declared UI expansion events (docs/spec/plugin-host.md#channel).
        if (params.name !== "exposure-request" && params.name !== "declared-ui.expanded") throw new TypeError(`native event ${params.name} is not served to a plugin host`);
        if (params.name === "exposure-request") exposureSubscribers.add(plugin);
        return { result: null };
      }
      if (event.command === "runtime.native.call") {
        // The registration notice of a view page: the same registration as page.exposure.register, from the view bridge.
        if (params.name === "registered") {
          const fields = params.payload;
          if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new TypeError(`plugin host call ${event.command} registered requires an object`);
          if (fields.kind !== "status" && fields.kind !== "dom") throw new TypeError(`plugin host call ${event.command} registered requires a status or dom kind`);
          register(plugin, fields.kind, fields.name, event.generation);
          return { result: null };
        }
        if (params.name !== "exposureReply") throw new TypeError(`plugin host call ${event.command} ${params.name} is not served`);
        return { result: answerExposure(plugin, params.payload) };
      }
      if (event.command.startsWith("runtime.sidecar.")) return await answerSidecar(event, params);
      if (event.command.startsWith("runtime.data.")) return await answerData(event, params);
      if (event.command === "runtime.command.register") {
        if (typeof params.name !== "string" || params.name === "") throw new TypeError(`plugin host call ${event.command} requires a non-empty name`);
      } else if (params.kind !== "status" && params.kind !== "dom") {
        throw new TypeError(`plugin host call ${event.command} requires a status or dom kind`);
      }
      register(plugin, event.command === "runtime.command.register" ? "command" : params.kind, params.name, event.generation);
      // default: a handler that registers nothing replies with null, which is the result of a call without a value.
      return { result: null };
    } catch (error) {
      // default: a rejection that is not an Error replies with its text.
      return { error: { code: FAILED_COMMAND, message: errorText(error) } };
    }
  };
  let off = null;
  let replies = null;
  let closed = false;
  const receive = (event) => {
    if (closed) return;
    if (event === null || typeof event !== "object" || !Number.isInteger(event.id)) {
      report(new TypeError("plugin host call has no integer id"));
      return;
    }
    return startDeclaredSnapshotIngress().then(() => {
      if (closed) return;
      if (typeof event.plugin !== "string" || !registerSourceOrigin(event.plugin, null, event.generation)) return;
      if (event.cancel === true) return;
      return answer(event).then(
        (reply) => bridge.call("pluginHostReply", { plugin: event.plugin, generation: event.generation, id: event.id, ...reply }),
        // default: a rejection that is not an Error replies, and a failed reply is reported, with its text.
        (error) => bridge.call("pluginHostReply", { plugin: event.plugin, generation: event.generation, id: event.id, error: { code: FAILED_COMMAND, message: errorText(error) } }),
      // default: a failed reply that is not an Error is reported with its text.
      ).catch((error) => report(new Error(`plugin host reply ${event.id}: ${errorText(error)}`)));
    }).catch(report);
  };
  replies = bridge.on("plugin-host-reply", (event) => {
    if (closed) return;
    startDeclaredSnapshotIngress().then(() => {
      if (closed) return;
      const commands = event?.plugin && hostCommandsOf(event.plugin);
      if (typeof event?.plugin === "string" && sourceOrigin(event.plugin, null) !== event.generation) return;
      // A reply whose current host has no layer arrived after the layer left. A retired generation is an expected cancellation.
      if (commands) commands.receive(event);
      else report(new Error(`plugin host reply ${event?.id} arrived after its host layer left`));
    }).catch(report);
  });
  // The end of a host removes its registrations and ends the open requests of this document to it.
  const ended = bridge.on("plugin-host-ended", (event) => {
    startDeclaredSnapshotIngress().then(() => {
      if (closed || typeof event?.plugin !== "string" || !Number.isSafeInteger(event.generation) || event.generation < 1) return;
      const currentOrigin = sourceOrigin(event.plugin, null);
      const currentLayer = hostCommandGeneration(event.plugin);
      if ((currentOrigin !== undefined && currentOrigin !== event.generation) ||
          (currentLayer !== null && currentLayer !== event.generation)) {
        try {
          unregister(event.plugin, event.generation);
        } catch (error) {
          report(error);
        }
        return;
      }
      const commands = hostCommandsOf(event.plugin);
      if (commands && ownedLayers.get(event.plugin) !== commands) return;
      layers.delete(event.plugin);
      layerGenerations.delete(event.plugin);
      ownedLayers.delete(event.plugin);
      forgetSessions(event.plugin);
      forgetExposure(event.plugin);
      // The host closes the plugin sessions that this window owns (docs/plans/plugin-host-routes.md rule 7).
      bridge.call("pluginHostSidecarClose", { plugin: event.plugin }).catch((error) => report(error));
      commands?.close();
      try {
        unregister(event.plugin, event.generation);
      } catch (error) {
        report(error);
      }
    }).catch(report);
  });
  Promise.resolve(bridge.on("plugin-host-call", receive)).then((unsubscribe) => {
    if (closed) unsubscribe();
    else off = unsubscribe;
  // default: a subscription failure that is not an Error is reported with its text.
  }, (error) => report(new Error(`plugin host calls: ${errorText(error)}`)));
  return {
    receive,
    close() {
      closed = true;
// default: a layer closed before its subscription settled has no unsubscribe; the settle unsubscribes it.
      off?.();
      for (const subscription of [replies, ended]) Promise.resolve(subscription).then((unsubscribe) => unsubscribe(), report);
      for (const [plugin, commands] of [...ownedLayers]) {
        if (layers.get(plugin) !== commands) {
          ownedLayers.delete(plugin);
          continue;
        }
        forgetExposure(plugin);
        forgetSessions(plugin);
        commands.close();
        const generation = layerGenerations.get(plugin);
        layers.delete(plugin);
        layerGenerations.delete(plugin);
        ownedLayers.delete(plugin);
        try {
          unregister(plugin, generation);
        } catch (error) {
          report(error);
        }
      }
    },
  };
}
