// The call route of a view (docs/spec/native-surfaces.md#view-surfaces). The host forwards each call request and each cancel of a view as
// the view-call event of the main page; answerViewCall answers it with the handlers that a DOM surface context uses.
import { causeCids } from "./calls.js";
import { runCommandCall } from "./command-route.js";
import { shellQuotePath } from "./clipboard.js";
import { surfaceDocumentEntry } from "./surface-document.js";

/** A binary id of the binary store of a view: 32 lowercase hexadecimal characters (docs/spec/plugin-processes.md#binary-path). */
const BINARY_ID = /^[0-9a-f]{32}$/;

/**
 * Answers one event of a view and resolves with its result. A call request {id, command, params} resolves with the result of its
 * handler and rejects with the reason of a refusal; it runs nothing that the request does not name. A cancel {id, cancel: true}
 * ends the pending call with that id, which then rejects with cancelled, and resolves with undefined: a cancel has no reply of its own.
 *
 *     event     {id, command, params} of a call request, or {id, cancel: true} of a cancel
 *     options   plugin: the plugin id of the view
 *               surface: the surface id of the view, which names the place of the error lines of the view
 *               pending: Map of the pending calls of the view, from id to AbortController; the caller keeps one Map for each view
 *               runCore(name, params): runs a core command, as runtime.command does
 *               runOwned(name, params, owner, cids, surface, caller): runs a command that the plugin registered, as the exposure owner
 *                 check does; surface names the surface that runs it, or undefined to choose it, and caller is the surface of the view
 *               shortcuts: the rows of the shortcut table of the workbench
 *               startProject(): the project {id, root} of the start values of the view, or null when they carry none
 *               emitEvent(level, event, fields): the event writer of the page, which stores the shortcut records of the view
 *               contributions(point): the connected items of the point, as contributions of the surface context returns them
 *               tab: the tab handlers of the surface context, as context.tab has: the reports title(text), footer(text),
 *                 directory(path), notify(text, policy), modified(value), error(text), keep(reason, on), focus(value), and state with
 *                 {read, write} only when the plugin declares surface.unload. focus(value) receives the value of the view call
 *                 tab.focus, {name, index} or null, and records it for the surface; the caller validates it and its errors reject the call.
 *               runtime: the handlers of the runtime entries of the DOM surface context
 *                 native.call(name, payload): the host call of the surface, as runtime.native.call
 *                 sidecar.send(id, body, cids, name): the send to the declared sidecar name, as runtime.sidecar(name).send
 *                 clipboard: the clipboard of the view, {read(type), writeText(text), readPNG(), persistPNG(binary)}; read takes
 *                   text or fileURLs as the clipboard bridge of the surface context does. A PNG travels through the binary store of
 *                   the view (docs/spec/plugin-processes.md#binary-path): readPNG puts the PNG of the clipboard into the store and
 *                   returns the host reply {present: true, type: "png", binary} or {present: false, type: "png"}, and persistPNG takes
 *                   the binary id of a PNG in the store and returns the host reply {path}
 *                 links.open(url): opens a link, as runtime.links.open
 *                 program.run(name, args): runs the program that the plugin declares as name, and resolves with the host reply
 *                   {code, stdout, stderr, truncated} (docs/spec/native-surfaces.md#program-runs); args is an array of texts
 *                 report(line): writes the error line `<where>: <text>` to the application log, the record path of the error
 *                   display of the page
 *                 textSize: {read(), on(listener)} of the surface, as runtime.textSize of the surface context has
 *                 settings: {read(), on(listener)} of the plugin, as runtime.settings of the surface context has
 *                 subscribe.native(name), subscribe.sidecarMessage(id, sidecar), subscribe.sidecarFailure(id), subscribe.textSize(),
 *                   subscribe.settings(), subscribe.logLevels(): register the page subscriptions of the view (view-events.js of this package); each resolves when it is
 *                   registered
 *                 holdsSurface(plugin, surface): whether the surface is a surface of the plugin in the window
 *                 dependsOn(plugin, owner): whether the plugin lists the owner, a plugin, in its dependencies, which lets a view of the
 *                   plugin follow the statuses that the owner declares (docs/spec/plugins.md#pluginjson)
 *                 menu: {declared(), frame()} of the surface: whether its plugin declares surface.menu for it, and its applied frame
 *                   {x, y} in the window or null
 *                 data.of(project, plugin): the project data of the plugin for the project, which the data calls read and write
 *                 subscribe.statusWatch(name, surface), subscribe.statusUnwatch(name, surface): follow the value of a status of the view on
 *                   the surface, or on the workbench when surface is undefined, and end it (view-events.js of this package); the names are checked by
 *                   statusNameOf, the surface by holdsSurface, and the declaration is checked by the page subscription
 *                 command.register(name): declares the command of the view on the page through the exposure registry, so a command of
 *                   another plugin or an undeclared name is refused (view-commands.js of this package)
 *                 exposure.registered({kind, name}): applies the status or element registration of the view through the exposure registry
 *                   and relays it to the host
 *               composition: the page operations of the surface view
 *                 declaration(): the declared {kind, regions, overlays} of the surface
 *                 place(regions, overlays): places one complete snapshot with the composition revision of the document
 *                 report(text): reports a failure of the composition through the report host call of the surface
 *                 document: {attach, load, zoom, go, post, subscribe, unsubscribe, detach} of the surface; attach goes through the
 *                   region record of the memory saver
 *                 image: {attach, focus, caret, text, detach} of the surface
 */
export async function answerViewCall(event, options) {
  if (event === null || typeof event !== "object") throw new TypeError("view call event is not an object");
  const { id, cancel, command, params, cids } = event;
  if (!Number.isInteger(id)) throw new TypeError("view call event has no integer id");
  // The identifiers of the cause of the call; a list that a line cannot hold is refused before any command runs.
  const carried = causeCids(cids);
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
    // A command of the plugin and a core command receive the identifiers of the call: the exposure registry takes them as the cids of
    // its run, and a core command passes them on the host calls that it makes (docs/spec/native-surfaces.md#view-surfaces).
    const withCause = {
      ...options,
      runOwned: (name, value, owner, surface) => options.runOwned(name, value, owner, carried, surface, options.surface),
      runCore: (name, value) => options.runCore(name, value, carried),
    };
    return await untilCancelled(run(command, params, withCause), controller.signal);
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


// The place of an error line has no control character and no ": ", because the record splits the line at its first ": ".
const ERROR_PLACE = /^(?!.*: )[^\u0000-\u001f\u007f]+$/;

// The core root of a view, from which it imports the module of a contribution item (docs/spec/plugin-processes.md, rule 4).
const CORE_ROOT = "soksak://core";

/**
 * The rows of the shortcut table that hold while a view has keyboard focus (docs/spec/native-surfaces.md#view-surfaces): a row of
 * any focus and a row whose owner is the view. A workbench row of another context holds only while the page has the focus.
 */
function viewShortcuts(shortcuts) {
  return shortcuts.filter((row) => row.owner === "workbench" || row.owner === "view")
    .map(({ key, owner, command }) => ({ key, owner, command }));
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
export const VIEW_BRIDGE_CALLS = new Set(["viewRequest", "viewEvent", "viewReply", "viewSidecarRoute", "viewSidecarSend"]);

// The host commands that plugin code may send through its native handle (docs/spec/native-surfaces.md#view-surfaces). A plugin
// reaches a host command only through this allowlist: a command that is not listed is refused, so a command added to the host
// stays closed to plugins until it is listed here.
export const PLUGIN_HOST_CALLS = new Set(["exposureReply"]);

// The native events of the region record that a view subscribes to (docs/spec/native-surfaces.md#view-surfaces, regions). The other
// events are internal to the view bridge.
export const REGION_EVENTS = new Set(["document-stream", "document-state", "document-message", "image-event"]);

// The native events that plugin code may subscribe to through its native handle (docs/spec/native-surfaces.md#view-surfaces, docs/spec/exposure.md#relay).
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

async function run(command, params, { plugin, surface, tab, shortcuts, emitEvent, contributions, runCore, runOwned, startProject, runtime, composition }) {

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
      // The status and element registration of the view page (docs/spec/native-surfaces.md#view-surfaces, view exposure).
      if (fields.name === "registered") {
        const payload = objectOf(fields.name, fields.payload);
        if (typeof payload.kind !== "string" || payload.kind === "") throw new TypeError(`view call ${fields.name} requires a non-empty kind`);
        if (typeof payload.name !== "string" || payload.name === "") throw new TypeError(`view call ${fields.name} requires a non-empty name`);
        // A plugin command keeps the forwarding handler of runtime.command.register; a registration here would route its requests
        // to the exposure-request listeners of the view instead.
        if (payload.kind === "command" && !surfaceDocumentEntry(payload.name)) {
          throw new Error(`view call ${fields.name}: command ${payload.name} is registered through runtime.command.register`);
        }
        return runtime.exposure.registered(payload);
      }
      // A value of a watched status of the view page (docs/spec/exposure.md#relay).
      if (fields.name === "changed") {
        const payload = objectOf(fields.name, fields.payload);
        if (typeof payload.name !== "string" || payload.name === "" || !("value" in payload)
          || !Number.isSafeInteger(payload.version) || payload.version < 1) {
          throw new TypeError(`view call ${fields.name} requires a non-empty name, a value and a positive integer version`);
        }
        return runtime.exposure.changed(payload);
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
      // contract: docs/spec/native-surfaces.md#view-surfaces, view calls. A binary payload of a call uses the binary path
      // (docs/spec/plugin-processes.md#binary-path), so a png read replies the id under which the host put the PNG into the binary
      // store of the view, which the view downloads, and an absent payload replies null.
      if (params === "png") {
        const png = await runtime.clipboard.readPNG();
        if (png?.type === "png" && png.present === false) return null;
        if (png?.type !== "png" || png.present !== true || !BINARY_ID.test(png.binary)) {
          throw new Error(`view call ${command} png: the clipboard png reply of the host is invalid: ${JSON.stringify(png)}`);
        }
        return { present: true, type: "png", binary: png.binary };
      }
      if (params !== "text" && params !== "fileURLs") throw new Error(`view call ${command} ${String(params)} is not served`);
      return runtime.clipboard.read(params);
    case "runtime.clipboard.persistPNG": {
      // The PNG arrives as the id of an upload of the view to its binary path (docs/spec/plugin-processes.md#binary-path).
      const fields = objectOf(command, params);
      if ("data" in fields) throw new TypeError(`view call ${command} takes the binary id of an upload, not base64 data`);
      if (!BINARY_ID.test(fields.binary)) {
        throw new TypeError(`view call ${command} requires binary, the id of an upload to the binary path of the view`);
      }
      const persisted = await runtime.clipboard.persistPNG(fields.binary);
      if (typeof persisted?.path !== "string" || persisted.path === "") {
        throw new Error(`view call ${command}: the clipboard PNG persistence reply of the host is invalid: ${JSON.stringify(persisted)}`);
      }
      return { path: persisted.path, shellQuotedPath: shellQuotePath(persisted.path) };
    }
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
      if (command === "runtime.sidecar.on") await runtime.subscribe.sidecarMessage(fields.id, fields.sidecar);
      else await runtime.subscribe.sidecarFailure(fields.id);
      return null;
    }
    case "runtime.command.register": {
      const fields = objectOf(command, params);
      if (typeof fields.name !== "string" || fields.name === "") throw new TypeError(`view call ${command} requires a non-empty name`);
      await runtime.command.register(fields.name);
      return null;
    }
    case "runtime.status.watch":
    case "runtime.status.unwatch": {
      const watch = statusWatchOf(command, params, plugin, runtime.holdsSurface, runtime.dependsOn);
      if (command === "runtime.status.watch") await runtime.subscribe.statusWatch(watch.name, watch.surface);
      else await runtime.subscribe.statusUnwatch(watch.name, watch.surface);
      return null;
    }
    // A command of the plugin on a named surface of the plugin, which a section view runs on the surface that it follows
    // (docs/spec/native-surfaces.md#view-surfaces, view calls). The surface is checked as a status watch checks it.
    case "runtime.command.run": {
      const fields = objectOf(command, params);
      if (typeof fields.name !== "string" || fields.name === "") throw new TypeError(`view call ${command} requires a non-empty name`);
      if (fields.name.slice(0, fields.name.indexOf(".")) !== plugin) throw new Error(`view call ${command} ${fields.name} is not a command of ${plugin}`);
      if (typeof fields.surface !== "string" || fields.surface === "") throw new TypeError(`view call ${command} requires a non-empty surface`);
      if (!runtime.holdsSurface(plugin, fields.surface)) throw new Error(`view call ${command} surface ${fields.surface} is not a surface of ${plugin}`);
      // default: a command without parameters runs with null, as runtime.command sends it.
      return runOwned(fields.name, fields.params ?? null, plugin, fields.surface);
    }
    // The project data of the plugin for the project of the start values of the view (docs/spec/plugins.md#project-data). A view of a
    // project that the window does not show reads and writes that project, so the project is not the shown one.
    case "runtime.data.get":
    case "runtime.data.set":
    case "runtime.data.replace": {
      const fields = objectOf(command, params);
      const project = startProject();
      if (project === null) throw new Error(`view call ${command} requires a project`);
      if (typeof fields.key !== "string" || fields.key === "") throw new TypeError(`view call ${command} requires a non-empty key`);
      // A write names no plugin, whatever the plugin is: a view changes the project data of its own plugin only.
      if (command !== "runtime.data.get" && Object.hasOwn(fields, "plugin")) {
        throw new Error(`view call ${command} ${fields.plugin} is read-only for ${plugin}: a view changes only the project data of its own plugin`);
      }
      const owner = dataOwnerOf(command, fields.plugin, plugin, runtime.dependsOn);
      const data = runtime.data.of(project, owner);
      if (!data.declares(fields.key)) throw new Error(`view call ${command} ${fields.key} is not a data key of ${owner}`);
      if (command === "runtime.data.get") return data.get(fields.key);
      if (command === "runtime.data.replace") {
        if (!Object.hasOwn(fields, "base")) throw new TypeError(`view call ${command} requires base`);
        return data.replace(fields.key, fields.base, fields.value);
      }
      await data.set(fields.key, fields.value);
      return null;
    }
    // A subscription to the project data of the plugin, or of a dependency that the call names (docs/spec/plugins.md#project-data).
    case "runtime.data.on": {
      if (startProject() === null) throw new Error(`view call ${command} requires a project`);
      // default: a subscription without params, or with null as runtime.data.on sends it, names no plugin.
      const named = params === null || params === undefined ? undefined : objectOf(command, params).plugin;
      const owner = dataOwnerOf(command, named, plugin, runtime.dependsOn);
      await runtime.subscribe.data(owner === plugin ? undefined : owner);
      return null;
    }
    case "runtime.links.open":
      if (typeof params !== "string" || params === "") throw new TypeError(`view call ${command} requires a non-empty URL`);
      await runtime.links.open(params);
      return null;
    // A program that the plugin declares runs with the argument texts; an absent args is an empty list (docs/spec/native-surfaces.md#program-runs).
    case "runtime.program.run": {
      const fields = objectOf(command, params);
      if (typeof fields.name !== "string" || fields.name === "") throw new TypeError(`view call ${command} requires a non-empty name`);
      const args = Object.hasOwn(fields, "args") ? fields.args : [];
      if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
        throw new TypeError(`view call ${command} args must be an array of texts`);
      }
      return runtime.program.run(fields.name, args);
    }
    case "tab.title":
      tab.title(params);
      return null;
    case "tab.focus":
      tab.focus(params);
      return null;
    case "tab.footer":
      tab.footer(params);
      return null;
    // A right click in the view opens the surface menu at its point in the window (docs/spec/native-surfaces.md#view-surfaces).
    case "surface.menu": {
      const fields = objectOf(command, params);
      if (!Number.isFinite(fields.x) || !Number.isFinite(fields.y)) throw new TypeError(`view call ${command} requires x and y as finite numbers`);
      if (!runtime.menu.declared()) return false;
      const frame = runtime.menu.frame();
      if (frame === null) throw new Error(`view call ${command} surface ${surface} has no applied frame`);
      await runCore("core.surface.menu", { surface, x: frame.x + fields.x, y: frame.y + fields.y });
      return true;
    }
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
    case "runtime.error": {
      // An error that the view shows on its own page is recorded at the moment it appears, as the error display of the page
      // records its errors (docs/spec/native-surfaces.md#view-surfaces).
      const fields = objectOf(command, params);
      if (typeof fields.where !== "string" || !ERROR_PLACE.test(fields.where)) {
        throw new TypeError(`view call ${command} requires a non-empty where without a control character or ": "`);
      }
      if (typeof fields.text !== "string" || fields.text === "") throw new TypeError(`view call ${command} requires a non-empty text`);
      await runtime.report(`surface ${surface} ${fields.where}: ${fields.text}`);
      return null;
    }
    case "runtime.shortcuts.read":
      return viewShortcuts(shortcuts);
    case "runtime.contributions": {
      // The module of an item is a path of the main page; a view imports it from the core root.
      const fields = objectOf(command, params);
      return contributions(fields.point).map(({ plugin: owner, index, item, module }) => ({ plugin: owner, index, item, module: `${CORE_ROOT}${module}` }));
    }
    case "runtime.contributions.fail": {
      const fields = objectOf(command, params);
      if (typeof fields.reason !== "string" || fields.reason === "") throw new TypeError(`view call ${command} requires a non-empty reason`);
      const entry = contributions(fields.point).find((item) => item.plugin === fields.plugin && item.index === fields.index);
      if (!entry) throw new Error(`view call ${command}: ${fields.point} has no connected item ${fields.index} of ${fields.plugin}`);
      entry.fail(fields.reason);
      return null;
    }
    case "runtime.textSize.read":
      return runtime.textSize.read();
    case "runtime.textSize.on":
      await runtime.subscribe.textSize();
      return null;
    case "runtime.log.levels.on":
      await runtime.subscribe.logLevels();
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
      // The hosts reply {handle}; the view call replies the handle number, by which the region record of the view keys the
      // messages and the close of the subscription.
      const reply = await composition.document.subscribe(fields.name, fields.stream);
      if (!Number.isSafeInteger(reply?.handle) || reply.handle < 0) {
        throw new Error(`document.subscribe ${fields.name} ${fields.stream}: the host reply has no handle: ${JSON.stringify(reply)}`);
      }
      return reply.handle;
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
  // A core command that the view runs through runtime.command. A failure is recorded only for the command of a workbench shortcut row,
  // which the view ran for its own forwarded key (docs/spec/native-surfaces.md#view-surfaces); any other failure is only replied.
  const runForwarded = async (name, args) => {
    try {
      return await runCore(name, args);
    } catch (error) {
      if (shortcuts.some((row) => row.owner === "workbench" && row.command === name)) {
        emitEvent("error", "workbench.input.shortcut.failed", { plugin, command: name });
      }
      throw error;
    }
  };
  return runCommandCall(command, params, { call: "view call", plugin, runCore: runForwarded, runOwned });
}

/**
 * The name and the surface of a status watch (docs/spec/native-surfaces.md#view-surfaces, view calls). surface is undefined when the
 * call names none. The surface of a watch must be a surface of the plugin of the view that the window holds; any other surface is refused
 * and runs nothing. An unwatch ends only a watch of this view, whose surface was checked when it started, so its surface is not checked:
 * the surface can close before the view unwatches it.
 */
function statusWatchOf(command, params, plugin, holdsSurface, dependsOn) {
  const fields = objectOf(command, params);
  const name = statusNameOf(command, fields.name, plugin, dependsOn);
  if (fields.surface === undefined) return { name, surface: undefined };
  if (typeof fields.surface !== "string" || fields.surface === "") throw new TypeError(`view call ${command} requires a non-empty surface`);
  if (command === "runtime.status.watch" && !holdsSurface(plugin, fields.surface)) {
    throw new Error(`view call ${command} surface ${fields.surface} is not a surface of ${plugin}`);
  }
  return { name, surface: fields.surface };
}

/**
 * The status name of a status watch (docs/spec/native-surfaces.md#view-surfaces, view calls): a core status, whose owner is core, a
 * status of the plugin of the view, or a status of a plugin that the plugin of the view lists in its dependencies (dependsOn(plugin, owner)).
 * A name without an owner or with any other owner is refused, and runs nothing.
 */
function statusNameOf(command, name, plugin, dependsOn) {
  if (typeof name !== "string" || name === "") throw new TypeError(`view call ${command} requires a non-empty name`);
  const dot = name.indexOf(".");
  const owner = dot < 0 ? null : name.slice(0, dot);
  if (owner !== "core" && owner !== plugin && !dependsOn(plugin, owner)) {
    throw new Error(`view call ${command} ${name} is neither a core status nor a status of ${plugin} or of its dependencies`);
  }
  return name;
}

/**
 * The plugin whose project data a data call reads or follows (docs/spec/plugins.md#project-data): the plugin of the view when the call
 * names none (named is undefined), and otherwise the dependency that it names, which the plugin of the view lists in its dependencies
 * (dependsOn(plugin, owner)). The plugin of the view itself is refused as no dependency, and so is an empty or non-text name.
 */
function dataOwnerOf(command, named, plugin, dependsOn) {
  if (named === undefined) return plugin;
  if (typeof named !== "string" || named === "") throw new TypeError(`view call ${command} requires a non-empty plugin`);
  if (named === plugin || !dependsOn(plugin, named)) throw new Error(`view call ${command} ${named} is not a dependency of ${plugin}`);
  return named;
}

/** The params of a call that takes named fields. Any other value is refused. */
function objectOf(command, params) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError(`view call ${command} requires an object`);
  }
  return params;
}

/**
 * The value of the view call tab.focus (docs/spec/native-surfaces.md#view-surfaces, view calls): {name, index} of the focused exposed
 * element of the view, or null when it has none. Any other value is refused, and the refusal names the value.
 */
export function checkViewFocus(value) {
  if (value !== null && (typeof value !== "object" || typeof value.name !== "string" || value.name === ""
      || !Number.isSafeInteger(value.index) || value.index < 0 || Object.keys(value).length !== 2)) {
    throw new TypeError(`view call tab.focus requires {name, index} or null, not ${JSON.stringify(value)}`);
  }
  return value;
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
