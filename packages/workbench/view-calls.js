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
 *                 sidecar.send(id, body, cids, name): the send to the declared sidecar name, as runtime.sidecar(name).send
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
 *                 exposure.registered({kind, name}): applies the status or dom registration of the view through the exposure registry
 *                   and relays it to the host (surface-modules.js)
 *               composition: the page operations of the surface that a hybrid composition uses (surface-modules.js)
 *                 declaration(): the declared {kind, regions, overlays} of the surface
 *                 place(regions, overlays): places one complete snapshot with the composition revision of the document
 *                 report(text): reports a failure of the composition through the report host call of the surface
 *                 document: {attach, load, zoom, go, post, subscribe, unsubscribe, detach} of the surface; attach goes through the
 *                   region record of the memory saver (document-regions.js)
 *                 image: {attach, focus, caret, text, detach} of the surface
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

// The host calls of the composition and the regions. A view operates its regions only through the composition calls, because a
// host call from the view would skip the revision of the document, the region lifetime and the region record
// (docs/spec/native-surfaces.md#view-surfaces, regions).
export const REGION_HOST_CALLS = new Set([
  "compositionDeclare", "compositionPlace",
  "documentAttach", "documentLoad", "documentZoom", "documentGo", "documentDetach", "documentSubscribe", "documentUnsubscribe",
  "documentPost", "documentQuery", "documentInteractionState",
  "imageAttach", "imageFocus", "imageCaret", "imageText", "imageDetach",
]);

// The host calls of the view bridge (docs/spec/native-surfaces.md#view-surfaces, view channel). The page sends them itself, so a
// plugin never reaches them.
export const VIEW_BRIDGE_CALLS = new Set(["viewRequest", "viewEvent", "viewReply"]);

// The host commands that plugin code may send through its native handle (docs/spec/native-surfaces.md#view-surfaces). A plugin
// reaches a host command only through this allowlist: a command that is not listed is refused, so a command added to the host
// stays closed to plugins until it is listed here.
export const PLUGIN_HOST_CALLS = new Set(["exposureReply"]);

// The native events of the region record that a view subscribes to (docs/spec/native-surfaces.md#view-surfaces, regions). The other
// events are internal to the view bridge.
export const REGION_EVENTS = new Set(["document-stream", "document-state", "document-message", "image-event"]);

// The native events that plugin code may subscribe to through its native handle (docs/spec/native-surfaces.md#plugin-host-calls, docs/spec/exposure.md#relay).
// The four region events, and exposure-request, the declared route of view exposure: the forwarded exposure request reaches the view
// through this subscription. Every other event name is refused.
export const PLUGIN_NATIVE_EVENTS = new Set([...REGION_EVENTS, "exposure-request"]);

/**
 * The plugin-facing native handle of a surface: the host calls and the native events that plugin code reaches through runtime.native.
 * call refuses the region calls and the view bridge calls, so a plugin reaches a region only through its composition. The refusal
 * is in this handle, not in each caller, so every plugin-facing path passes it.
 */
export function pluginNativeGate(native) {
  return {
    call(name, payload) {
      if (REGION_HOST_CALLS.has(name)) {
        return Promise.reject(new Error(`host call ${name} is not served: a view operates its regions through its composition`));
      }
      if (VIEW_BRIDGE_CALLS.has(name)) return Promise.reject(new Error(`host call ${name} is not served: the view bridge is internal`));
      if (!PLUGIN_HOST_CALLS.has(name)) return Promise.reject(new Error(`host call ${name} is not served to plugins`));
      return native.call(name, payload);
    },
    on(name, listener) {
      if (!PLUGIN_NATIVE_EVENTS.has(name)) return Promise.reject(new Error(`native event ${name} is not served: the view bridge is internal`));
      return native.on(name, listener);
    },
  };
}

/** The named fields of a region call, whose name is the region name. Any other value is refused. */
function regionOf(command, params) {
  const fields = objectOf(command, params);
  if (typeof fields.name !== "string" || fields.name === "") throw new TypeError(`view call ${command} requires a non-empty region name`);
  return fields;
}

async function run(command, params, { plugin, tab, runCore, runOwned, runtime, composition }) {
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
      // The status and dom registration of the view page (docs/spec/native-surfaces.md#view-surfaces, view exposure).
      if (fields.name === "registered") {
        const payload = objectOf(fields.name, fields.payload);
        if (typeof payload.kind !== "string" || payload.kind === "") throw new TypeError(`view call ${fields.name} requires a non-empty kind`);
        if (typeof payload.name !== "string" || payload.name === "") throw new TypeError(`view call ${fields.name} requires a non-empty name`);
        return runtime.exposure.registered(payload);
      }
      if (REGION_HOST_CALLS.has(fields.name)) {
        throw new Error(`view call ${command} ${fields.name} is not served: a view operates its regions through its composition`);
      }
      return runtime.native.call(fields.name, fields.payload);
    }
    case "runtime.sidecar.send": {
      const fields = objectOf(command, params);
      if (typeof fields.sidecar !== "string" || fields.sidecar === "") throw new TypeError(`view call ${command} requires a non-empty sidecar`);
      return runtime.sidecar.send(fields.id, fields.body, fields.cids, fields.sidecar);
    }
    case "runtime.clipboard.read":
      // default: the PNG type is binary and has no JSON reply, so a PNG read is refused (docs/spec/plugin-processes.md, rule 3).
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
    // The composition and the regions of the view run the page operations of its surface with the named fields only, so a field such
    // as surface in the params reaches no host call (docs/spec/native-surfaces.md#view-surfaces, regions).
    case "composition.declaration":
      return composition.declaration();
    case "composition.place": {
      const fields = objectOf(command, params);
      if (!Array.isArray(fields.regions) || !Array.isArray(fields.overlays)) {
        throw new TypeError(`view call ${command} requires the arrays regions and overlays`);
      }
      return composition.place(fields.regions, fields.overlays);
    }
    case "composition.report":
      if (typeof params !== "string" || params === "") throw new TypeError(`view call ${command} requires a non-empty text`);
      return composition.report(params);
    case "document.attach":
      return composition.document.attach(regionOf(command, params).name);
    case "document.load": {
      const fields = regionOf(command, params);
      return composition.document.load(fields.name, fields.url);
    }
    case "document.zoom": {
      const fields = regionOf(command, params);
      return composition.document.zoom(fields.name, fields.zoom);
    }
    case "document.go": {
      const fields = regionOf(command, params);
      return composition.document.go(fields.name, fields.action, fields.offset);
    }
    case "document.post": {
      const fields = regionOf(command, params);
      return composition.document.post(fields.name, fields.message);
    }
    case "document.subscribe": {
      const fields = regionOf(command, params);
      return composition.document.subscribe(fields.name, fields.stream);
    }
    case "document.unsubscribe": {
      const fields = regionOf(command, params);
      return composition.document.unsubscribe(fields.name, fields.handle);
    }
    case "document.detach":
      return composition.document.detach(regionOf(command, params).name);
    case "image.attach": {
      const fields = regionOf(command, params);
      return composition.image.attach(fields.name, fields.sidecar);
    }
    case "image.focus":
      return composition.image.focus(regionOf(command, params).name);
    case "image.caret": {
      const fields = regionOf(command, params);
      return composition.image.caret(fields.name, fields.x, fields.y, fields.width, fields.height);
    }
    case "image.text": {
      const fields = regionOf(command, params);
      return composition.image.text(fields.name, fields.text);
    }
    case "image.detach":
      return composition.image.detach(regionOf(command, params).name);
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
