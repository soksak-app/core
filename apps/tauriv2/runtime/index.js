// Tauri v2.
//
// 커맨드를 이름으로 호출한다. Tauri 가 페이지 스크립트보다 먼저 인터페이스를
// 주입하므로 대기가 필요 없다. 표면과 모달 페이지도 같은 인터페이스를 사용한다.
import { HostWorkspaceStore } from "@soksak/workbench/host-store.js";
import { hostWindows } from "@soksak/workbench/host-windows.js";
import { createClipboardBridge } from "@soksak/plugin-api";

const COMMAND = {
  workspace: "workspace",
  windowNew: "window_new", folderChoose: "folder_choose", projectCreate: "project_create",
  projectFolder: "project_folder", projectOpen: "project_open", projectRelease: "project_release",
  windowState: "window_state", windowReady: "window_ready", windowClose: "window_close",
  syncSurfaces: "sync_surfaces",
  presentSurfaces: "present_surfaces",
  waitPresented: "wait_presented",
  setTheme: "set_theme",
  theme: "theme",
  report: "report",
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
  documentDetach: "document_detach",
  sidecarSend: "sidecar_send",
  sidecarsRetain: "sidecars_retain",
  clipboardRead: "clipboard_read",
  linkOpen: "link_open",
  notify: "notify",
  notificationRemove: "notification_remove",
  notificationState: "notification_state",
  clipboardWriteText: "clipboard_write_text",
  clipboardPersistPNG: "clipboard_persist_png",
};

// 커맨드마다 인자의 이름이 다르다. 이름은 Rust 쪽 서명이 정한다.
const ARG = {
  workspace: (request) => ({ request }),
  windowNew: () => ({}), folderChoose: () => ({}), projectCreate: (request) => ({ request }),
  projectFolder: (root) => ({ root }), projectOpen: (request) => ({ request }), projectRelease: (id) => ({ id }),
  windowState: () => ({}), windowReady: () => ({}), windowClose: () => ({}),
  syncSurfaces: (v) => ({ request: v }),
  presentSurfaces: (v) => ({ request: v }),
  waitPresented: () => ({}),
  setTheme: (v) => ({ theme: v }),
  theme: () => ({}),
  report: (v) => {
    if (typeof v !== "string") throw new TypeError("report requires a string");
    return { line: v };
  },
  overlayShow: (v) => ({ request: v }),
  overlayPlace: (v) => ({ request: v }),
  setShape: (v) => ({ request: v }),
  clearShape: (v) => ({ id: v }),
  overlayUpdate: (v) => ({ request: v }),
  overlayHide: (v) => ({ id: v }),
  windowControls: () => ({}),
  exposureReply: (request) => ({ request }),
  exposureChanged: (request) => ({ request }),
  exposureForward: (request) => ({ request }),
  imageAttach: (request) => ({ request }),
  compositionDeclare: (request) => ({ request }),
  compositionPlace: (request) => ({ request }),
  imageFocus: (request) => ({ request }),
  imageCaret: ({ surface, name, x, y, width, height }) => ({ request: { surface, name }, x, y, w: width, h: height }),
  imageText: ({ surface, name, text }) => ({ request: { surface, name }, text }),
  imageDetach: (request) => ({ request }),
  documentAttach: (request) => ({ request }),
  documentLoad: (request) => ({ request }),
  documentZoom: (request) => ({ request }),
  documentGo: (request) => ({ request }),
  documentDetach: (request) => ({ request }),
  sidecarSend: ({ sidecar, surface, body }) => ({ sidecar, surface, body }),
  sidecarsRetain: (request) => ({ request }),
  clipboardRead: (request) => ({ request }),
  linkOpen: (request) => ({ request }),
  notify: (request) => ({ request }),
  notificationRemove: (request) => ({ request }),
  notificationState: () => ({}),
  clipboardWriteText: (text) => ({ text }),
  clipboardPersistPNG: (request) => ({ request }),
};

export const host = (() => {
  const { invoke } = window.__TAURI__.core;
  const listen = (event, fn) => window.__TAURI__.event.listen(event, fn,
    { target: { kind: "Webview", label: window.__TAURI__.webview.getCurrentWebview().label } });
  return {
    call(name, arg) {
      const command = COMMAND[name];
      if (!command) return Promise.reject(new Error(`unknown host call: ${name}`));
      return invoke(command, ARG[name](arg));
    },
    // Tauri 이벤트는 값을 `payload` 필드에 담는다.
    on: (event, fn) => listen(event, (e) => fn(e.payload)),
    // 제목 표시줄이 투명하고 콘텐츠가 그 아래까지 차지하므로, 끄는 자리를 이
    // 문서가 지정한다.
    draggable(el) {
      el.setAttribute("data-tauri-drag-region", "");
    },
  };
})();

export const clipboard = createClipboardBridge((name, payload) => host.call(name, payload), { allowPersist: true });

export const page = (() => {
  const { invoke } = window.__TAURI__.core;
  const listen = (event, fn) => window.__TAURI__.event.listen(event, fn,
    { target: { kind: "Webview", label: window.__TAURI__.webview.getCurrentWebview().label } });
  // 표면 id 는 문서 주소의 id 다. 워크벤치가 표면을 그 탭 id 로 연다.
  const surface = new URLSearchParams(location.search).get("id");
  return {
    theme(fn) {
      invoke("theme").then(fn);
      listen("theme", (e) => fn(e.payload));
    },
    sidecar: (name) => ({
      send: (surface, body) => invoke("sidecar_send", { sidecar: name, surface, body }),
      // 사이드카 이벤트는 창의 모든 페이지가 받는다. 사이드카와 표면이 일치하는 것만 처리한다.
      on: (surface, fn) => listen("sidecar-message", (e) => {
        if (e.payload.sidecar === name && e.payload.surface === surface) fn(e.payload.body);
      }),
    }),
    // 공개 항목의 등록과 요청. 요청 이벤트에 surface 가 있으면 이 표면의 것만 처리한다.
    exposure: {
      register: (kind, name) => invoke("exposure_register", { request: { surface, kind, name } }),
      onRequest: (fn) => listen("exposure-request", (e) => {
        if (e.payload.surface === undefined || e.payload.surface === surface) fn(e.payload);
      }),
      reply: (id, payload) => invoke("exposure_reply", { request: { id, ...payload, ...(surface ? { surface } : {}) } }),
    },
    // 이 표면의 문서 영역. 호스트는 호출한 웹뷰가 surface 인지 확인하고 상태를 이 표면에만 보낸다.
    document: {
      attach: (document) => invoke("document_attach", { request: { surface, document } }),
      load: (document, url) => invoke("document_load", { request: { surface, document, url } }),
      zoom: (document, zoom) => invoke("document_zoom", { request: { surface, document, zoom } }),
      go: (document, action, offset) => invoke("document_go", { request: offset === undefined ? { surface, document, action } : { surface, document, action, offset } }),
      detach: (document) => invoke("document_detach", { request: { surface, document } }),
      onState: (fn) => listen("document-state", (e) => {
        if (e.payload.surface === surface) fn(e.payload.document, e.payload.state);
      }),
    },
    // 이 표면의 그림 영역. 호스트는 호출한 웹뷰가 surface 인지 확인하고 이벤트를 이 표면에만 보낸다.
    image: {
      attach: (name, sidecar) => invoke("image_attach", { request: { surface, name, sidecar } }),
      focus: (name) => invoke("image_focus", { request: { surface, name } }),
      caret: (name, x, y, w, h) => invoke("image_caret", { request: { surface, name }, x, y, w, h }),
      text: (name, text) => invoke("image_text", { request: { surface, name }, text }),
      detach: (name) => invoke("image_detach", { request: { surface, name } }),
      on: (fn) => listen("image-event", (e) => {
        if (e.payload.surface === surface) fn(e.payload.name, e.payload.event);
      }),
    },
    composition: {
      place: (revision, regions, overlays) =>
        invoke("composition_place", { request: { surface, revision, regions, overlays } }),
    },
    modal: {
      content(id, instance, fn, place) {
        // 이벤트는 모든 페이지가 받는다. 자기 모달의 것만 취한다.
        return Promise.all([listen("modal-content", (e) => {
          const { payload } = e;
          if (payload.id === id && payload.instance === instance) fn({ revision: payload.revision, content: payload.content });
        }), listen("modal-position", (e) => {
          const { payload } = e;
          if (payload.id === id && payload.instance === instance) place({ revision: payload.revision, card: payload.card });
        })]).then(() => invoke("overlay_content", { id, instance })).then(fn);
      },
      ready: (id, instance) => invoke("overlay_ready", { id, instance }),
      answer: (id, instance, key, value) => invoke("overlay_pick", { id, instance, key, value }),
    },
  };
})();

/** 설정과 프로젝트 목록은 네이티브 호스트가 저장한다. */
export const openStore = async () => new HostWorkspaceStore(host);

/** 창과 프로젝트 폴더는 네이티브 호스트가 관리한다. */
export const windows = hostWindows(host);
