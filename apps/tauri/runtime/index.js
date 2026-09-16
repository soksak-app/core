// Tauri v2.
//
// 커맨드를 이름으로 호출한다. Tauri 가 페이지 스크립트보다 먼저 인터페이스를
// 주입하므로 대기가 필요 없다. 표면과 모달 페이지도 같은 인터페이스를 사용한다.
import { HostWorkspaceStore } from "@soksak/workbench/host-store.js";

const COMMAND = {
  workspace: "workspace",
  windowNew: "window_new", folderChoose: "folder_choose", projectCreate: "project_create",
  projectFolder: "project_folder", projectOpen: "project_open", projectRelease: "project_release",
  windowState: "window_state", windowReady: "window_ready", windowClose: "window_close",
  syncSurfaces: "sync_surfaces",
  presentSurfaces: "present_surfaces",
  setTheme: "set_theme",
  report: "report",
  overlayShow: "overlay_show",
  overlayPlace: "overlay_place",
  setShape: "set_shape",
  clearShape: "clear_shape",
  overlayUpdate: "overlay_update",
  overlayHide: "overlay_hide",
  windowControls: "window_controls",
};

// 커맨드마다 인자의 이름이 다르다. 이름은 Rust 쪽 서명이 정한다.
const ARG = {
  workspace: (request) => ({ request }),
  windowNew: () => ({}), folderChoose: () => ({}), projectCreate: (request) => ({ request }),
  projectFolder: (root) => ({ root }), projectOpen: (request) => ({ request }), projectRelease: (id) => ({ id }),
  windowState: () => ({}), windowReady: () => ({}), windowClose: () => ({}),
  syncSurfaces: (v) => ({ request: v }),
  presentSurfaces: (v) => ({ request: v }),
  setTheme: (v) => ({ theme: v }),
  report: (v) => ({ line: v }),
  overlayShow: (v) => ({ request: v }),
  overlayPlace: (v) => ({ request: v }),
  setShape: (v) => ({ request: v }),
  clearShape: (v) => ({ id: v }),
  overlayUpdate: (v) => ({ request: v }),
  overlayHide: (v) => ({ id: v }),
  windowControls: () => ({}),
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
    // 이 애플리케이션이 서비스하는 문서의 경로. 두 네이티브 런타임이 같은 형식을 사용한다.
    page: (path) => `/${path}`,
    // 제목 표시줄이 투명하고 콘텐츠가 그 아래까지 차지하므로, 끄는 자리를 이
    // 문서가 지정한다.
    draggable(el) {
      el.setAttribute("data-tauri-drag-region", "");
    },
  };
})();

export const page = (() => {
  const { invoke } = window.__TAURI__.core;
  const listen = (event, fn) => window.__TAURI__.event.listen(event, fn,
    { target: { kind: "Webview", label: window.__TAURI__.webview.getCurrentWebview().label } });
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
    modal: {
      content(id, instance, fn, place) {
        // 이벤트는 모든 페이지가 받는다. 자기 모달의 것만 취한다.
        return Promise.all([listen("modal-content", (e) => {
          if (e.payload.id === id && e.payload.instance === instance) fn(e.payload.content);
        }), listen("modal-position", (e) => {
          if (e.payload.id === id && e.payload.instance === instance) place(e.payload.card);
        })]).then(() => invoke("overlay_content", { id, instance })).then(fn);
      },
      ready: (id, instance) => invoke("overlay_ready", { id, instance }),
      answer: (id, instance, key, value) => invoke("overlay_pick", { id, instance, key, value }),
    },
  };
})();

/** 설정과 프로젝트 목록은 네이티브 호스트가 저장한다. */
export const openStore = async () => new HostWorkspaceStore(host);
