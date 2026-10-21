// The page side of the plugin host channel (docs/spec/plugin-host.md#channel). The host relays each call request of a host
// page as the event plugin-host-call of the main page, and the main page answers it with the pluginHostReply host call; the
// host serves only the registration calls of exposure and refuses every other command. The requests of the main page to a
// host page, such as the pull of a declared status, go through the pluginHostRequest host call, and the page answers them
// as replies that the host relays as the events plugin-host-reply.

import { host as bridge } from "@soksak/runtime";
import { createViewCommands } from "./view-commands.js";

/** The code of a command that failed: EXPOSURE_ERRORS.failed of plugin-api. */
const FAILED_COMMAND = -32000;

/** The key that a plugin host registers under, from its plugin id (docs/spec/plugin-host.md#exposure). */
export const hostKeyOf = (plugin) => `plugin:${plugin}`;

/** The plugin of a host key, or null for a key that is not one. */
export const pluginOfHostKey = (key) => (typeof key === "string" && key.startsWith("plugin:") ? key.slice("plugin:".length) : null);

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
export const servedPluginHostCall = (command) => command === "runtime.command.register" || command === "page.exposure.register";

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
export function listenPluginHostCalls({ register, unregister, timeoutOf, report }) {
  if ([register, unregister, timeoutOf, report].some((value) => typeof value !== "function")) {
    throw new TypeError("listenPluginHostCalls requires the register, unregister, timeoutOf and report functions");
  }
  const answer = async (event) => {
    const { plugin, id } = event;
    try {
      if (!servedPluginHostCall(event.command)) {
        throw new Error(`plugin host call ${event.command} is not served`);
      }
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
      (error) => bridge.call("pluginHostReply", { plugin: event.plugin, id: event.id, error: { code: FAILED_COMMAND, message: String(error?.message ?? error) } }),
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
  }, (error) => report(new Error(`plugin host calls: ${error?.message ?? error}`)));
  return {
    receive,
    close() {
      closed = true;
      off?.();
      for (const subscription of [replies, ended]) Promise.resolve(subscription).then((unsubscribe) => unsubscribe(), report);
      for (const commands of layers.values()) commands.close();
      layers.clear();
    },
  };
}
