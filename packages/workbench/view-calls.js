// The call route of a view (docs/spec/native-surfaces.md#view-surfaces). The host forwards each call request and each cancel of a view as
// the view-call event of the main page; answerViewCall answers it with the handlers that a DOM surface context uses.

/**
 * Answers one event of a view and resolves with its result. A call request {id, command, params} resolves with the result of its
 * handler and rejects with the reason of a refusal; it runs nothing that the request does not name. A cancel {id, cancel: true}
 * ends the pending call with that id, which then rejects with cancelled, and resolves with undefined: a cancel has no reply of its own.
 *
 *     event     {id, command, params} of a call request, or {id, cancel: true} of a cancel
 *     options   plugin: the plugin id of the view
 *               pending: Map of the pending calls of the view, from id to AbortController; the caller keeps one Map for each view
 *               runCore(name, params): runs a core command, as runtime.command does
 *               runOwned(name, params, owner): runs a command that the plugin registered, as the exposure owner check does
 *               tab: the tab handlers of the surface context, as context.tab has: the reports title(text), footer(text),
 *                 directory(path), notify(text, policy), modified(value), error(text), keep(reason, on), and state with
 *                 {read, write} only when the plugin declares surface.unload
 *               runtime: the handlers of the runtime entries of the DOM surface context
 *                 native.call(name, payload): the host call of the surface, as runtime.native.call
 *                 sidecar.send(id, body, cids): the send to the declared sidecar, as runtime.sidecar().send
 *                 clipboard: {read(type), writeText(text)}, the clipboard bridge without the PNG bytes
 *                 links.open(url): opens a link, as runtime.links.open
 *                 log: the log levels of the page, as runtime.log of the surface context has; the level gate of the page
 *                   applies at delivery, and a gated record is counted there
 *                 textSize: {read(), on(listener)} of the surface, as runtime.textSize of the surface context has
 *                 settings: {read(), on(listener)} of the plugin, as runtime.settings of the surface context has
 *                 subscribe.native(name), subscribe.sidecarMessage(id), subscribe.sidecarFailure(id), subscribe.textSize(),
 *                   subscribe.settings(): register the page subscriptions of the view (view-events.js); each resolves when it is
 *                   registered
 *                 command.register(name): declares the command of the view on the page through the exposure registry, so a command of
 *                   another plugin or an undeclared name is refused (view-commands.js)
 */
export async function answerViewCall(event, options) {
  if (event === null || typeof event !== "object") throw new TypeError("view call event is not an object");
  const { id, cancel, command, params } = event;
  if (!Number.isInteger(id)) throw new TypeError("view call event has no integer id");
  const { pending } = options;
  if (cancel === true) {
    // default: a cancel of a call that has no pending call ends nothing, because that call has already replied.
    pending.get(id)?.abort();
    return undefined;
  }
  if (typeof command !== "string" || command === "") throw new Error(`view call ${id} has an empty command`);
  if (pending.has(id)) throw new Error(`view call ${id} is already pending`);
  const controller = new AbortController();
  pending.set(id, controller);
  try {
    return await untilCancelled(run(command, params, options), controller.signal);
  } finally {
    pending.delete(id);
  }
}

/**
 * Settles as promise does, unless signal aborts first. An abort rejects with cancelled. The work of promise continues, and its
 * result is discarded, because the call that it answers has already replied.
 */
function untilCancelled(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function run(command, params, { plugin, tab, runCore, runOwned, runtime }) {
  switch (command) {
    case "tab.state.read":
      if (!tab?.state) throw new Error(`view call ${command}: the tab state is not declared`);
      return tab.state.read();
    case "tab.state.write":
      if (!tab?.state) throw new Error(`view call ${command}: the tab state is not declared`);
      tab.state.write(params);
      return null;
    case "runtime.native.call": {
      const fields = objectOf(command, params);
      if (typeof fields.name !== "string" || fields.name === "") throw new TypeError(`view call ${command} requires a non-empty name`);
      return runtime.native.call(fields.name, fields.payload);
    }
    case "runtime.sidecar.send": {
      const fields = objectOf(command, params);
      return runtime.sidecar.send(fields.id, fields.body, fields.cids);
    }
    case "runtime.clipboard.read":
      // default: the PNG type is binary and has no JSON reply, so a PNG read is refused (docs/plans/plugin-processes.md, rule 3).
      if (params !== "text" && params !== "fileURLs") throw new Error(`view call ${command} ${String(params)} is not served`);
      return runtime.clipboard.read(params);
    case "runtime.clipboard.writeText":
      if (typeof params !== "string") throw new TypeError(`view call ${command} requires a string`);
      await runtime.clipboard.writeText(params);
      return null;
    case "runtime.native.on": {
      const fields = objectOf(command, params);
      if (typeof fields.name !== "string" || fields.name === "") throw new TypeError(`view call ${command} requires a non-empty name`);
      await runtime.subscribe.native(fields.name);
      return null;
    }
    case "runtime.sidecar.on":
    case "runtime.sidecar.onFailure": {
      const fields = objectOf(command, params);
      if (typeof fields.id !== "string" || fields.id === "") throw new TypeError(`view call ${command} requires a non-empty id`);
      if (command === "runtime.sidecar.on") await runtime.subscribe.sidecarMessage(fields.id);
      else await runtime.subscribe.sidecarFailure(fields.id);
      return null;
    }
    case "runtime.command.register": {
      const fields = objectOf(command, params);
      if (typeof fields.name !== "string" || fields.name === "") throw new TypeError(`view call ${command} requires a non-empty name`);
      await runtime.command.register(fields.name);
      return null;
    }
    case "runtime.links.open":
      if (typeof params !== "string" || params === "") throw new TypeError(`view call ${command} requires a non-empty URL`);
      await runtime.links.open(params);
      return null;
    case "tab.title":
      tab.title(params);
      return null;
    case "tab.footer":
      tab.footer(params);
      return null;
    case "tab.directory":
      tab.directory(params);
      return null;
    case "tab.modified":
      tab.modified(params);
      return null;
    case "tab.error":
      tab.error(params);
      return null;
    case "tab.notify": {
      const fields = objectOf(command, params);
      tab.notify(fields.text, fields.policy);
      return null;
    }
    case "tab.keep": {
      const fields = objectOf(command, params);
      tab.keep(fields.reason, fields.on);
      return null;
    }
    case "runtime.log": {
      // The page builds the fields before the send, and the level gate of the page applies at delivery: a gated record is
      // counted by the gate of the event writer, and none is dropped silently.
      const fields = objectOf(command, params);
      const send = runtime.log?.[fields.level];
      if (typeof send !== "function") {
        throw new TypeError(`view call ${command} log level must be one of error, warn, info, debug, trace`);
      }
      send(fields.event, fields.fields);
      return null;
    }
    case "runtime.textSize.read":
      return runtime.textSize.read();
    case "runtime.textSize.on":
      await runtime.subscribe.textSize();
      return null;
    case "runtime.settings.read":
      return runtime.settings.read();
    case "runtime.settings.on":
      await runtime.subscribe.settings();
      return null;
    default:
      break;
  }
  const dot = command.indexOf(".");
  const owner = dot < 0 ? "" : command.slice(0, dot);
  if (owner === "core") return runCore(command, params);
  if (owner === plugin) return runOwned(command, params, plugin);
  if (owner === "") throw new Error(`view call ${command} names no owner`);
  // The tab and runtime names that the switch above does not serve are refused as not served, not as the names of another owner.
  if (owner === "tab" || owner === "runtime") throw new Error(`view call ${command} is not served`);
  throw new Error(`command ${command} belongs to ${owner}, not ${plugin}`);
}

/** The params of a call that takes named fields. Any other value is refused. */
function objectOf(command, params) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError(`view call ${command} requires an object`);
  }
  return params;
}

/**
 * The state of a surface whose view stopped its restarts (docs/spec/native-surfaces.md#view-surfaces): the card shows the reason of
 * the view-stopped event as the error of the surface. An event without a reason is refused.
 */
export function viewStopState(event) {
  if (event === null || typeof event !== "object") throw new TypeError("view stop event is not an object");
  if (typeof event.reason !== "string" || event.reason === "") throw new TypeError("view stop event has no reason");
  return { phase: "error", error: new Error(event.reason) };
}
