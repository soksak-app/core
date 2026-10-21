// Wails v3.
//
// The main page uses the Wails runtime, and additional webviews use the native bridge of the app.
// They share the asset server of the webview configuration, so documents load from the same scheme.
//
// Calls a method of the host through the one bound method `Call` of the service Bindings, which records every call. Wails
// derives the name of the service from the import path of the host package and the type name,
// github.com/soksak-app/core/packages/host/wailsv3/src.Bindings.
//
// The runtime is an ES module at /wails/runtime.js, so it is
// loaded with import, not with a script tag. The import is asynchronous, so the two interfaces below call after it completes.
import { HostWorkspaceStore } from "@soksak/workbench/host-store.js";
import { hostWindows } from "@soksak/workbench/host-windows.js";
import { settlingCalls } from "@soksak/workbench/host-calls.js";
import { surfaceCalls } from "@soksak/workbench/surface-calls.js";
import { createClipboardBridge } from "@soksak/plugin-api";
import { createLifecycleListener } from "./listener-lifecycle.js";

const SERVICE = "github.com/soksak-app/core/packages/host/wailsv3/src.Bindings";

/* The runtime module. An import is evaluated only once. */
const runtime = () => import("/wails/runtime.js");

/** A call of a bound method with its arguments and the correlation identifiers of the operation it carries out (docs/spec/logging.md#operation-chains). */
const call = (method, args, cids) =>
  window.__soksakNative?.call
    ? Promise.resolve(window.__soksakNative.call(method, args))
    // default: a call that carries out no operation has an empty list of identifiers.
    : runtime().then((r) => r.Call.ByName(`${SERVICE}.Call`, method, args, cids ?? []));

/** Event reception. The payload is carried in the `data` field. */
const listen = createLifecycleListener((event, fn) =>
  runtime().then(async (r) => {
    const name = await r.Window.Name();
    return r.Events.On(event, (e) => { if (e.sender === name) fn(e.data); });
  }));

const METHOD = {
  workspace: "Workspace",
  windowNew: "WindowNew", folderChoose: "FolderChoose", projectCreate: "ProjectCreate",
  projectFolder: "ProjectFolder",
  projectOpen: "ProjectOpen",
  projectRelease: "ProjectRelease",
  projectRemoveAsk: "ProjectRemoveAsk",
  projectRemoveAnswer: "ProjectRemoveAnswer",
  windowState: "WindowState",
  windowReady: "WindowReady",
  windowClose: "WindowClose",
  windowCloseKept: "WindowCloseKept",
  appUpdateState: "AppUpdateState",
  appUpdateStage: "AppUpdateStage",
  appUpdateApply: "AppUpdateApply",
  syncSurfaces: "SyncSurfaces",
  presentSurfaces: "PresentSurfaces",
  waitPresented: "WaitPresented",
  setTheme: "SetTheme",
  setMenuLanguage: "SetMenuLanguage",
  theme: "Theme",
  overlayShow: "OverlayShow",
  overlayPlace: "OverlayPlace",
  setShape: "SetShape",
  clearShape: "ClearShape",
  overlayUpdate: "OverlayUpdate",
  overlayHide: "OverlayHide",
  windowControls: "WindowControls",
  exposureReply: "ExposureReply",
  exposureChanged: "ExposureChanged",
  exposureForward: "ExposureForward",
  exposureRegister: "ExposureRegister",
  compositionDeclare: "CompositionDeclare",
  performance: "Performance",
  log: "Log",
  compositionPlace: "CompositionPlace",
  imageAttach: "ImageAttach",
  imageFocus: "ImageFocus",
  imageCaret: "ImageCaret",
  imageText: "ImageText",
  imageDetach: "ImageDetach",
  documentAttach: "DocumentAttach",
  documentLoad: "DocumentLoad",
  documentZoom: "DocumentZoom",
  documentGo: "DocumentGo",
  documentQuery: "DocumentQuery",
  documentInteractionState: "DocumentInteractionState",
  documentPost: "DocumentPost",
  viewEvent: "ViewEvent", viewReply: "ViewReply", viewRequest: "ViewRequest",
  pluginHostReply: "PluginHostReply", pluginHostRequest: "PluginHostRequest", pluginHostEvent: "PluginHostEvent", pluginHostSidecarSend: "PluginHostSidecarSend", pluginHostSidecarClose: "PluginHostSidecarClose",
  documentDetach: "DocumentDetach",
  documentSubscribe: "DocumentSubscribe",
  documentUnsubscribe: "DocumentUnsubscribe",
  sidecarSend: "SidecarSend",
  sidecarsRetain: "SidecarsRetain",
  sidecarsReplace: "SidecarsReplace",
  sidecarsOutdated: "SidecarsOutdated",
  clipboardRead: "ClipboardRead",
  linkOpen: "LinkOpen",
  notify: "Notify",
  notificationRemove: "NotificationRemove",
  notificationState: "NotificationState",
  clipboardWriteText: "ClipboardWriteText",
  clipboardPersistPNG: "ClipboardPersistPNG",
  pluginsState: "PluginsState",
  debugFiles: "DebugFiles",
  debugRecord: "DebugRecord",
  debugSave: "DebugSave",
  debugSaveText: "DebugSaveText",
  filePlace: "FilePlace",
  logQuery: "LogQuery",
  debugSaveAll: "DebugSaveAll",
  debugRead: "DebugRead",
  pluginsRun: "PluginsRun",
  pluginsUseRegistry: "PluginsUseRegistry",
};

/* Calls of the main page. Counts them so that every call sent before the page reloads itself receives a reply (docs/spec/native-host.md#page-reload). */
const mainCalls = settlingCalls((name, arg, options) => {
  const method = METHOD[name];
  if (!method) return Promise.reject(new Error(`unknown host call: ${name}`));
  // A call without arguments sends no arguments. Sending one undefined makes the binding
  // reject the call because the argument count does not match.
  if (name === "sidecarSend") return call(method, [arg.sidecar, arg.surface, arg.body, arg.cids], options.cids);
  if (name === "imageCaret") return call(method, [{ surface: arg.surface, name: arg.name }, arg.x, arg.y, arg.width, arg.height], options.cids);
  if (name === "imageText") return call(method, [{ surface: arg.surface, name: arg.name }, arg.text], options.cids);
  return call(method, arg === undefined ? [] : [arg], options.cids);
});

export const host = {
  // options.cids are the correlation identifiers of the operation that the call carries out (operations.js).
  call: (name, arg, options) => (options?.cids ? mainCalls.callContinuing(options.cids, name, arg) : mainCalls.call(name, arg)),
  // Reloads this page after every sent call has received a reply. Calls after that are not sent.
  reload: () => mainCalls.settle().then(() => location.reload()),
  on: listen,
  // The title bar is transparent and the content extends under it, so this document
  // specifies the drag area.
  draggable(el) {
    el.style.setProperty("--wails-draggable", "drag");
  },
};

export const clipboard = createClipboardBridge((name, payload) => host.call(name, payload), { allowPersist: true });

/* The methods that a document of a surface calls, by the name its events carry (docs/spec/logging.md#automatic-entrances). */
const SURFACE_METHOD = {
  theme: "Theme",
  sidecarSend: "SidecarSend",
  exposureRegister: "ExposureRegister",
  exposureReply: "ExposureReply",
  documentAttach: "DocumentAttach",
  documentLoad: "DocumentLoad",
  documentZoom: "DocumentZoom",
  documentGo: "DocumentGo",
  documentDetach: "DocumentDetach",
  documentSubscribe: "DocumentSubscribe",
  documentUnsubscribe: "DocumentUnsubscribe",
  imageAttach: "ImageAttach",
  imageFocus: "ImageFocus",
  imageCaret: "ImageCaret",
  imageText: "ImageText",
  imageDetach: "ImageDetach",
  compositionPlace: "CompositionPlace",
  modalContent: "ModalContent",
  modalReady: "ModalReady",
  overlayPick: "OverlayPick",
};

export const page = (() => {
  const listen = createLifecycleListener((event, fn) => window.__soksakNative.on(event, fn));
  const calls = surfaceCalls({
    send: (name, ...args) => {
      const method = SURFACE_METHOD[name];
      if (!method) throw new Error(`unknown surface call: ${name}`);
      return window.__soksakNative.call(method, args);
    },
    log: (request) => window.__soksakNative.call("Log", [request]),
    listen,
  });
  const call = calls.call;
  // The surface id is the id in the document address. The workbench opens the surface with that tab id.
  const surface = new URLSearchParams(location.search).get("id");
  // A document of a surface or a modal names its id and takes the log policy from the host; the main page has no id.
  if (surface) calls.followPolicy();
  return {
    theme(fn) {
      call("theme").then(fn);
      listen("theme", fn);
    },
    // Stores a record of this document in the event log of the host as the event `page.record.<level>`, in the batch of the
    // events of its turn (docs/spec/diagnostics.md#forms, docs/spec/logging.md#writers).
    report: async (record) => {
      if (!record || typeof record !== "object" || typeof record.level !== "string" || typeof record.where !== "string" || typeof record.text !== "string") {
        throw new TypeError("report requires {level, where, text} strings");
      }
      return calls.record(record.level, `page.record.${record.level}`, { where: record.where, text: record.text });
    },
    sidecar: (name) => ({
      send: (surface, body, cids = []) => call("sidecarSend", name, surface, body, cids),
      // Sidecar events are received by every page of the window. Only the events that match the sidecar and the surface are handled.
      on: (surface, fn) => listen("sidecar-message", (message) => {
        if (message.sidecar === name && message.surface === surface) fn(message.body);
      }),
      // Sidecar failures are also received by every page of the window (docs/spec/sidecars.md#failure).
      onFailure: (surface, fn) => listen("sidecar-failure", (failure) => {
        if (failure.sidecar === name && failure.surface === surface) fn(failure.reason);
      }),
    }),
    // Registration and requests of exposed entries. When a request event has a surface, only the events of this surface are handled.
    exposure: {
      register: (kind, name) => call("exposureRegister", { surface, kind, name }),
      onRequest: (fn) => listen("exposure-request", (request) => {
        if (request.surface === undefined || request.surface === surface) fn(request);
      }),
      reply: (id, payload) => call("exposureReply", { id, ...payload }),
    },
    // The document region of this surface. The host verifies that the calling webview is the surface and sends the state only to this surface.
    document: {
      attach: (document) => call("documentAttach", { surface, document }),
      load: (document, url) => call("documentLoad", { surface, document, url }),
      zoom: (document, zoom) => call("documentZoom", { surface, document, zoom }),
      go: (document, action, offset) => call("documentGo", offset === undefined ? { surface, document, action } : { surface, document, action, offset }),
      detach: (document) => call("documentDetach", { surface, document }),
      onState: (fn) => listen("document-state", (sent) => {
        if (sent.surface === surface) fn(sent.document, sent.state);
      }),
    },
    // The image region of this surface. The host verifies that the calling webview is the surface and sends events only to this surface.
    image: {
      attach: (name, sidecar) => call("imageAttach", { surface, name, sidecar }),
      focus: (name) => call("imageFocus", { surface, name }),
      caret: (name, x, y, w, h) => call("imageCaret", { surface, name }, x, y, w, h),
      text: (name, text) => call("imageText", { surface, name }, text),
      detach: (name) => call("imageDetach", { surface, name }),
      on: (fn) => listen("image-event", (sent) => {
        if (sent.surface === surface) fn(sent.name, sent.event);
      }),
    },
    composition: {
      place: (revision, regions, overlays) =>
        call("compositionPlace", { surface, revision, regions, overlays }),
    },
    modal: {
      content(id, instance, fn, place) {
        return Promise.all([listen("modal-content", (sent) => {
          if (sent.id === id && sent.instance === instance) fn({ revision: sent.revision, content: sent.content });
        }), listen("modal-position", (sent) => {
          if (sent.id === id && sent.instance === instance) place({ revision: sent.revision, card: sent.card });
        })]).then(() => call("modalContent", id, instance)).then(fn);
      },
      ready: (id, instance) => call("modalReady", id, instance),
      answer: (id, instance, key, value) => call("overlayPick", id, instance, key, value),
    },
  };
})();

/** The native host stores settings and the project list. */
export const openStore = async () => new HostWorkspaceStore(host);

/** The native host manages windows and project folders. */
export const windows = hostWindows(host);
