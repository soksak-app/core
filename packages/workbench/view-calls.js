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
 *               tab: {read(), write(value)} of the tab state of the surface, or null when the plugin declares no surface.unload
 *               runCore(name, params): runs a core command, as runtime.command does
 *               runOwned(name, params, owner): runs a command that the plugin registered, as the exposure owner check does
 *               runtime: the handlers of the runtime entries of the DOM surface context
 *                 native.call(name, payload): the host call of the surface, as runtime.native.call
 *                 sidecar.send(id, body, cids): the send to the declared sidecar, as runtime.sidecar().send
 *                 clipboard: {read(type), writeText(text)}, the clipboard bridge without the PNG bytes
 *                 links.open(url): opens a link, as runtime.links.open
 */
export async function answerViewCall(event, options) {
  const { id, cancel, command, params } = event ?? {};
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
      if (!tab) throw new Error(`view call ${command}: the tab state is not declared`);
      return tab.read();
    case "tab.state.write":
      if (!tab) throw new Error(`view call ${command}: the tab state is not declared`);
      tab.write(params);
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
    case "runtime.links.open":
      if (typeof params !== "string" || params === "") throw new TypeError(`view call ${command} requires a non-empty URL`);
      await runtime.links.open(params);
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
