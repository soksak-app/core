// The page side of the plugin host channel (docs/spec/plugin-host.md#channel). The host relays each call request of a host
// page as the event plugin-host-call of the main page, and the main page answers it with the pluginHostReply host call; the
// host serves only the registration calls of exposure and refuses every other command. The requests of the main page to a
// host page, such as the pull of a declared status, go through the pluginHostRequest host call, and the page answers them
// as replies that the host relays as the events plugin-host-reply.

import { host as bridge } from "@soksak/runtime";
import { reportRecord } from "./page-log.js";
import { createViewCommands } from "./view-commands.js";

/** The code of a command that failed: EXPOSURE_ERRORS.failed of plugin-api. */
const FAILED_COMMAND = -32000;

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
 * sidecar.json, whose message form the body takes and whose hostReadOperations allow the operation. Returns the body
 * re-serialized from the parsed object, so the check and the sidecar read the same value; throws a named error otherwise.
 */
export function checkHostSidecarRequest({ plugin, sidecar, declared = [], sidecarDeclaration, body }) {
  const refuse = (reason) => new Error(`plugin host ${plugin}: ${reason}`);
  const form = sidecarDeclaration?.message;
  if (form === undefined) throw refuse(`sidecar ${sidecar} declares no message form`);
  let object;
  try {
    object = typeof body === "string" ? JSON.parse(body) : undefined;
  } catch {
    object = undefined;
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) throw refuse("body is not a JSON object");
  const operation = object[form.operationField];
  if (typeof operation !== "string") throw refuse("operation is missing or not a string");
  const readable = sidecarDeclaration.hostReadOperations ?? [];
  if (!declared.includes(operation) || !readable.includes(operation)) throw refuse(`operation ${operation} is not served`);
  return JSON.stringify(object);
}

/** The served calls of the channel of a plugin host (docs/spec/plugin-host.md#channel). */
export const servedPluginHostCall = (command) => command === "runtime.command.register" || command === "page.exposure.register"
  || command === "runtime.sidecar.send" || command === "runtime.sidecar.on" || command === "runtime.sidecar.onFailure";

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
  // default: a post that the host refuses is written at error with its reason.
  bridge.call("pluginHostEvent", { plugin, event: kind, sidecar, id: session, ...fields }).catch((error) => {
    reportRecord("error", `plugin host ${plugin}: sidecar event ${kind} for ${session} not delivered: ${error?.message ?? error}`);
  });
}

// The sidecar listeners of the page, installed once when a host first subscribes to a session.
let sessionListeners = null;
function listenSessionEvents() {
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

/** Keeps the command layer of the host of plugin and returns the function that removes it. */
export function keepHostCommands(plugin, commands) {
  layers.set(plugin, commands);
  return () => {
    if (layers.get(plugin) === commands) layers.delete(plugin);
  };
}

/** The command layer of the host of plugin, or null while its answers are not connected. */
export function hostCommandsOf(plugin) {
  // default: a host whose answers are not connected has no layer, and its reader treats null as no request path.
  return layers.get(plugin) ?? null;
}

/**
 * Creates the command layer of one plugin host. run(name, params) posts {id, command, params} to the host through
 * pluginHostRequest and resolves with the reply that arrives as the plugin-host-reply event of the plugin; receive(event)
 * takes such an event. close() ends every open call of the host with surface-closed.
 */
export function createHostCommands({ plugin, timeoutOf, report }) {
  if (typeof timeoutOf !== "function" || typeof report !== "function") {
    throw new TypeError("createHostCommands requires the timeoutOf and report functions");
  }
  const commands = createViewCommands({
    plugin,
    post: (message) => bridge.call("pluginHostRequest", { plugin, id: message.id, command: message.command, params: message.params }),
    timeoutOf,
    report,
  });
  return {
    run: commands.run,
    receive(event) {
      // The reply of a host page names no surface; receive of the view layer drops it with the plugin.
      commands.receive({ surface: undefined, ...event });
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
export function listenPluginHostCalls({ register, unregister, timeoutOf, report, sidecarsOf = () => [] }) {
  if ([register, unregister, timeoutOf, report, sidecarsOf].some((value) => typeof value !== "function")) {
    throw new TypeError("listenPluginHostCalls requires the register, unregister, timeoutOf, report and sidecarsOf functions");
  }
  // The declared sidecar of the plugin named by a request, with the operations its host may call (rule 8). default: a plugin
  // with no sidecarsOf entries declares none, so every sidecar request of its host is refused by name.
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
      if (commands === null) {
        commands = createHostCommands({ plugin, timeoutOf, report });
        keepHostCommands(plugin, commands);
      }
      if (event.command.startsWith("runtime.sidecar.")) return await answerSidecar(event, params);
      if (event.command === "runtime.command.register") {
        if (typeof params.name !== "string" || params.name === "") throw new TypeError(`plugin host call ${event.command} requires a non-empty name`);
      } else if (params.kind !== "status" && params.kind !== "dom") {
        throw new TypeError(`plugin host call ${event.command} requires a status or dom kind`);
      }
      register(plugin, event.command === "runtime.command.register" ? "command" : params.kind, params.name);
      // default: a handler that registers nothing replies with null, which is the result of a call without a value.
      return { result: null };
    } catch (error) {
      // default: a rejection that is not an Error replies with its text.
      return { error: { code: FAILED_COMMAND, message: String(error?.message ?? error) } };
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
    if (event.cancel === true) return;
    answer(event).then(
      (reply) => bridge.call("pluginHostReply", { plugin: event.plugin, id: event.id, ...reply }),
      // default: a rejection that is not an Error replies, and a failed reply is reported, with its text.
      (error) => bridge.call("pluginHostReply", { plugin: event.plugin, id: event.id, error: { code: FAILED_COMMAND, message: String(error?.message ?? error) } }),
    // default: a failed reply that is not an Error is reported with its text.
    ).catch((error) => report(new Error(`plugin host reply ${event.id}: ${error?.message ?? error}`)));
  };
  replies = bridge.on("plugin-host-reply", (event) => {
    const commands = event?.plugin && hostCommandsOf(event.plugin);
    // default: a reply whose host has no layer arrived after the layer left; it answers no open call.
    commands?.receive(event);
  });
  // The end of a host removes its registrations and ends the open requests of this document to it.
  const ended = bridge.on("plugin-host-ended", (event) => {
    if (closed || typeof event?.plugin !== "string") return;
    const commands = hostCommandsOf(event.plugin);
    layers.delete(event.plugin);
    forgetSessions(event.plugin);
    // The host closes the plugin sessions that this window owns (docs/plans/plugin-host-routes.md rule 7).
    bridge.call("pluginHostSidecarClose", { plugin: event.plugin }).catch((error) => report(error));
    commands?.close();
    try {
      unregister(event.plugin);
    } catch (error) {
      report(error);
    }
  });
  Promise.resolve(bridge.on("plugin-host-call", receive)).then((unsubscribe) => {
    if (closed) unsubscribe();
    else off = unsubscribe;
  // default: a subscription failure that is not an Error is reported with its text.
  }, (error) => report(new Error(`plugin host calls: ${error?.message ?? error}`)));
  return {
    receive,
    close() {
      closed = true;
// default: a layer closed before its subscription settled has no unsubscribe; the settle unsubscribes it.
      off?.();
      for (const subscription of [replies, ended]) Promise.resolve(subscription).then((unsubscribe) => unsubscribe(), report);
      for (const commands of layers.values()) commands.close();
      layers.clear();
    },
  };
}
