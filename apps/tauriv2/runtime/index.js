// Tauri v2.
//
// Invokes a command by name. Tauri injects the interface before the page scripts,
// so no waiting is needed. Surface pages and modal pages use the same interface.
import { HostWorkspaceStore } from "@soksak/workbench/host-store.js";
import { hostWindows } from "@soksak/workbench/host-windows.js";
import { settlingCalls } from "@soksak/workbench/host-calls.js";
import { surfaceCalls } from "@soksak/workbench/surface-calls.js";
import { createClipboardBridge } from "@soksak/plugin-api";
import { createLifecycleListener } from "./listener-lifecycle.js";

const COMMAND = {
  workspace: "workspace",
  windowNew: "window_new", folderChoose: "folder_choose", projectCreate: "project_create",
  projectFolder: "project_folder", projectOpen: "project_open", projectRelease: "project_release", projectRemoveAsk: "project_remove_ask", projectRemoveAnswer: "project_remove_answer",
  windowState: "window_state", performance: "performance", log: "log", windowReady: "window_ready", windowClose: "window_close", windowCloseKept: "window_close_kept", appUpdateState: "app_update_state", appUpdateStage: "app_update_stage", appUpdateApply: "app_update_apply",
  syncSurfaces: "sync_surfaces",
  presentSurfaces: "present_surfaces",
  waitPresented: "wait_presented",
  setTheme: "set_theme",
  setMenuLanguage: "set_menu_language",
  theme: "theme",
 
  overlayShow: "overlay_show",
  overlayPlace: "overlay_place",
  setShape: "set_shape",
  clearShape: "clear_shape",
  overlayUpdate: "overlay_update",
  overlayHide: "overlay_hide",
  windowControls: "window_controls",
  exposureReply: "exposure_reply",
  exposureChanged: "exposure_changed",
  exposureForward: "exposure_forward",
  imageAttach: "image_attach",
  compositionDeclare: "composition_declare",
  compositionPlace: "composition_place",
  imageFocus: "image_focus",
  imageCaret: "image_caret",
  imageText: "image_text",
  imageDetach: "image_detach",
  documentAttach: "document_attach",
  documentLoad: "document_load",
  documentZoom: "document_zoom",
  documentGo: "document_go",
  documentPost: "document_post",
  documentDetach: "document_detach",
  documentSubscribe: "document_subscribe",
  documentUnsubscribe: "document_unsubscribe",
  sidecarSend: "sidecar_send",
  sidecarsRetain: "sidecars_retain",
  sidecarsReplace: "sidecars_replace",
  sidecarsOutdated: "sidecars_outdated",
  clipboardRead: "clipboard_read",
  linkOpen: "link_open",
  notify: "notify",
  notificationRemove: "notification_remove",
  notificationState: "notification_state",
  clipboardWriteText: "clipboard_write_text",
  clipboardPersistPNG: "clipboard_persist_png",
  pluginsState: "plugins_state",
  debugFiles: "debug_files",
  debugRecord: "debug_record",
  debugSave: "debug_save",
  debugSaveText: "debug_save_text",
  filePlace: "file_place",
  logQuery: "log_query",
  debugSaveAll: "debug_save_all",
  debugRead: "debug_read",
  pluginsRun: "plugins_run",
  pluginsUseRegistry: "plugins_use_registry",
};

// The argument names differ per command. The Rust signature determines the names.
const ARG = {
  workspace: (request) => ({ request }),
  windowNew: () => ({}), folderChoose: () => ({}), projectCreate: (request) => ({ request }),
  projectFolder: (root) => ({ root }), projectOpen: (request) => ({ request }), projectRelease: (id) => ({ id }),
  projectRemoveAsk: (id) => ({ id }), projectRemoveAnswer: (answer) => ({ answer }),
  windowState: () => ({}), windowReady: () => ({}), windowClose: () => ({}), windowCloseKept: () => ({}), appUpdateState: () => ({}), appUpdateStage: (request) => ({ request }), appUpdateApply: (request) => ({ request }),
  syncSurfaces: (v) => ({ request: v }),
  presentSurfaces: (v) => ({ request: v }),
  waitPresented: () => ({}),
  setTheme: (v) => ({ theme: v }),
  setMenuLanguage: (v) => {
    if (!/^[a-z]{2,8}$/.test(v)) throw new TypeError(`menu language must be a language tag, got ${v}`);
    return { language: v };
  },
  theme: () => ({}),
  overlayShow: (v) => ({ request: v }),
  overlayPlace: (v) => ({ request: v }),
  setShape: (v) => ({ request: v }),
  clearShape: (v) => ({ id: v }),
  overlayUpdate: (v) => ({ request: v }),
  overlayHide: (v) => ({ id: v }),
  windowControls: () => ({}),
  // Responses and state values are sent as JSON text. Tauri reads a command argument as a value that changes key order, so it must be sent
  // as text for the host to relay the key order of the page value unchanged (docs/spec/exposure.md).
  exposureReply: (request) => ({ request: JSON.stringify(request) }),
  exposureChanged: (request) => ({ request: { ...request, value: JSON.stringify(request.value) } }),
  exposureForward: (request) => ({ request }),
  imageAttach: (request) => ({ request }),
  compositionDeclare: (request) => ({ request }),
  performance: (request) => ({ request }),
  log: (request) => ({ request }),
  compositionPlace: (request) => ({ request }),
  imageFocus: (request) => ({ request }),
  imageCaret: ({ surface, name, x, y, width, height }) => ({ request: { surface, name }, x, y, w: width, h: height }),
  imageText: ({ surface, name, text }) => ({ request: { surface, name }, text }),
  imageDetach: (request) => ({ request }),
  documentAttach: (request) => ({ request }),
  documentLoad: (request) => ({ request }),
  documentZoom: (request) => ({ request }),
  documentGo: (request) => ({ request }),
  documentPost: (request) => ({ request }),
  documentDetach: (request) => ({ request }),
  documentSubscribe: (request) => ({ request }),
  documentUnsubscribe: (request) => ({ request }),
  sidecarSend: ({ sidecar, surface, body, cids }) => ({ sidecar, surface, body, cids }),
  sidecarsRetain: (request) => ({ request }),
  sidecarsReplace: (request) => ({ request }),
  sidecarsOutdated: () => ({}),
  clipboardRead: (request) => ({ request }),
  linkOpen: (request) => ({ request }),
  notify: (request) => ({ request }),
  notificationRemove: (request) => ({ request }),
  notificationState: () => ({}),
  clipboardWriteText: (text) => ({ text }),
  clipboardPersistPNG: (request) => ({ request }),
  pluginsState: () => ({}),
  debugFiles: () => ({}),
  debugRecord: (request) => ({ request }),
  debugSave: (request) => ({ request }),
  debugSaveText: (request) => ({ request }),
  filePlace: (request) => ({ request }),
  logQuery: (request) => ({ request }),
  debugSaveAll: () => ({}),
  debugRead: (request) => ({ request }),
  pluginsRun: (request) => ({ request }),
  pluginsUseRegistry: (request) => ({ request }),
};

/**
 * Tauri invoke. When a host command fails, Tauri rejects with the error value of the host (usually a string) as it is, so the value is
 * wrapped in an Error that the page can read as error.message.
 */
function hostInvoke() {
  const { invoke } = window.__TAURI__.core;
  return (command, args) => invoke(command, args).catch((reason) => {
    if (reason instanceof Error) throw reason;
    throw new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
  });
}

export const host = (() => {
  const invoke = hostInvoke();
  const listen = createLifecycleListener((event, fn) => window.__TAURI__.event.listen(event, fn,
    { target: { kind: "Webview", label: window.__TAURI__.webview.getCurrentWebview().label } }));
  // Calls of the main page. Counts them so that every call sent before the page reloads itself receives a reply (docs/spec/native-host.md#page-reload).
  const mainCalls = settlingCalls((name, arg, options) => {
    const command = COMMAND[name];
    if (!command) return Promise.reject(new Error(`unknown host call: ${name}`));
    // The correlation identifiers of the operation travel beside the arguments of the command (docs/spec/logging.md#operation-chains).
    return invoke(command, options.cids ? { ...ARG[name](arg), cids: options.cids } : ARG[name](arg));
  });
  return {
    // options.cids are the correlation identifiers of the operation that the call carries out (operations.js).
    call: (name, arg, options) => (options?.cids ? mainCalls.callContinuing(options.cids, name, arg) : mainCalls.call(name, arg)),
    // Reloads this page after every sent call has received a reply. Calls after that are not sent.
    reload: () => mainCalls.settle().then(() => location.reload()),
    // A Tauri event carries its value in the `payload` field.
    on: (event, fn) => listen(event, (e) => fn(e.payload)),
    // The title bar is transparent and the content extends under it, so this
    // document specifies the drag area.
    draggable(el) {
      el.setAttribute("data-tauri-drag-region", "");
    },
  };
})();

export const clipboard = createClipboardBridge((name, payload) => host.call(name, payload), { allowPersist: true });

/*
 * The commands that a document of a surface calls, by the name its events carry (docs/spec/logging.md#automatic-entrances),
 * and the arguments of each command from the arguments of the call. The names and arguments are those of the Wails runtime.
 */
function surfaceWire(surface) {
  const request = (name, command) => [name, { command, arguments: (value) => ({ request: value }) }];
  return Object.fromEntries([
    ["theme", { command: "theme", arguments: () => ({}) }],
    ["sidecarSend", { command: "sidecar_send", arguments: (sidecar, from, body, cids) => ({ sidecar, surface: from, body, cids }) }],
    request("exposureRegister", "exposure_register"),
    ["exposureReply", { command: "exposure_reply", arguments: (reply) => ({ request: JSON.stringify({ ...reply, ...(surface ? { surface } : {}) }) }) }],
    request("documentAttach", "document_attach"),
    request("documentLoad", "document_load"),
    request("documentZoom", "document_zoom"),
    request("documentGo", "document_go"),
    request("documentDetach", "document_detach"),
    request("documentSubscribe", "document_subscribe"),
    request("documentUnsubscribe", "document_unsubscribe"),
    request("imageAttach", "image_attach"),
    request("imageFocus", "image_focus"),
    ["imageCaret", { command: "image_caret", arguments: (value, x, y, w, h) => ({ request: value, x, y, w, h }) }],
    ["imageText", { command: "image_text", arguments: (value, text) => ({ request: value, text }) }],
    request("imageDetach", "image_detach"),
    request("compositionPlace", "composition_place"),
    ["modalContent", { command: "overlay_content", arguments: (id, instance) => ({ id, instance }) }],
    ["modalReady", { command: "overlay_ready", arguments: (id, instance) => ({ id, instance }) }],
    ["overlayPick", { command: "overlay_pick", arguments: (id, instance, key, value) => ({ id, instance, key, value }) }],
  ]);
}

export const page = (() => {
  const invoke = hostInvoke();
  const wire = surfaceWire(new URLSearchParams(location.search).get("id"));
  const listen = createLifecycleListener((event, fn) => window.__TAURI__.event.listen(event, fn,
    { target: { kind: "Webview", label: window.__TAURI__.webview.getCurrentWebview().label } }));
  const calls = surfaceCalls({
    send: (name, ...args) => {
      const entry = wire[name];
      if (!entry) throw new Error(`unknown surface call: ${name}`);
      return invoke(entry.command, entry.arguments(...args));
    },
    log: (request) => invoke("log", { request }),
    listen: (event, fn) => listen(event, (e) => fn(e.payload)),
  });
  const call = calls.call;
  // The surface id is the id in the document address. The workbench opens the surface with that tab id.
  const surface = new URLSearchParams(location.search).get("id");
  // A document of a surface or a modal names its id and takes the log policy from the host; the main page has no id.
  if (surface) calls.followPolicy();
  return {
    theme(fn) {
      call("theme").then(fn);
      listen("theme", (e) => fn(e.payload));
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
      on: (surface, fn) => listen("sidecar-message", (e) => {
        if (e.payload.sidecar === name && e.payload.surface === surface) fn(e.payload.body);
      }),
      // Sidecar failures are also received by every page of the window (docs/spec/sidecars.md#failure).
      onFailure: (surface, fn) => listen("sidecar-failure", (e) => {
        if (e.payload.sidecar === name && e.payload.surface === surface) fn(e.payload.reason);
      }),
    }),
    // Registration and requests of exposed entries. When a request event has a surface, only the events of this surface are handled.
    exposure: {
      register: (kind, name) => call("exposureRegister", { surface, kind, name }),
      onRequest: (fn) => listen("exposure-request", (e) => {
        if (e.payload.surface === undefined || e.payload.surface === surface) fn(e.payload);
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
      onState: (fn) => listen("document-state", (e) => {
        if (e.payload.surface === surface) fn(e.payload.document, e.payload.state);
      }),
    },
    // The image region of this surface. The host verifies that the calling webview is the surface and sends events only to this surface.
    image: {
      attach: (name, sidecar) => call("imageAttach", { surface, name, sidecar }),
      focus: (name) => call("imageFocus", { surface, name }),
      caret: (name, x, y, w, h) => call("imageCaret", { surface, name }, x, y, w, h),
      text: (name, text) => call("imageText", { surface, name }, text),
      detach: (name) => call("imageDetach", { surface, name }),
      on: (fn) => listen("image-event", (e) => {
        if (e.payload.surface === surface) fn(e.payload.name, e.payload.event);
      }),
    },
    composition: {
      place: (revision, regions, overlays) =>
        call("compositionPlace", { surface, revision, regions, overlays }),
    },
    modal: {
      content(id, instance, fn, place) {
        // Events are received by every page. Only the events of its own modal are taken.
        return Promise.all([listen("modal-content", (e) => {
          const { payload } = e;
          if (payload.id === id && payload.instance === instance) fn({ revision: payload.revision, content: payload.content });
        }), listen("modal-position", (e) => {
          const { payload } = e;
          if (payload.id === id && payload.instance === instance) place({ revision: payload.revision, card: payload.card });
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
