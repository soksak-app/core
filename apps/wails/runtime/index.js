// Wails v3.
//
// 메인 페이지는 Wails 런타임을, 추가 웹뷰는 앱의 네이티브 브리지를 사용한다.
// 웹뷰 설정의 자산 서버를 공유하므로 문서는 같은 스킴에서 로드된다.
//
// 바인딩된 메서드를 「패키지 · 타입 · 이름」으로 호출한다. 이 서비스는 이름을
// 지정하지 않으므로 Wails 는 패키지와 타입 이름인 main.Host 를 사용한다.
//
// 런타임은 /wails/runtime.js 의 ES 모듈이므로 script 태그가 아니라 import 로
// 로드한다. import 는 비동기이므로 아래 두 인터페이스는 완료를 기다린 뒤 호출한다.
import { HostWorkspaceStore } from "@soksak/workbench/host-store.js";

const SERVICE = "main.Host";

/* 런타임 모듈. import 는 한 번만 평가된다. */
const runtime = () => import("/wails/runtime.js");

/** 바인딩된 메서드 호출. */
const call = (method, ...args) =>
  runtime().then((r) => r.Call.ByName(`${SERVICE}.${method}`, ...args));

/** 이벤트 수신. payload 는 `data` 필드에 담긴다. */
const listen = (event, fn) =>
  runtime().then(async (r) => {
    const name = await r.Window.Name();
    return r.Events.On(event, (e) => { if (e.sender === name) fn(e.data); });
  });

const METHOD = {
  workspace: "Workspace",
  windowNew: "WindowNew", folderChoose: "FolderChoose", projectCreate: "ProjectCreate",
  projectFolder: "ProjectFolder",
  projectOpen: "ProjectOpen",
  projectRelease: "ProjectRelease",
  windowState: "WindowState",
  windowReady: "WindowReady",
  windowClose: "WindowClose",
  syncSurfaces: "SyncSurfaces",
  presentSurfaces: "PresentSurfaces",
  setTheme: "SetTheme",
  report: "Report",
  overlayShow: "OverlayShow",
  overlayPlace: "OverlayPlace",
  setShape: "SetShape",
  clearShape: "ClearShape",
  overlayUpdate: "OverlayUpdate",
  overlayHide: "OverlayHide",
  windowControls: "WindowControls",
};

export const host = {
  call(name, arg) {
    const method = METHOD[name];
    if (!method) return Promise.reject(new Error(`unknown host call: ${name}`));
    // 인자가 없는 호출은 인자를 보내지 않는다. undefined 를 하나 보내면 바인딩이
    // 인자 수가 맞지 않는다고 거절한다.
    return arg === undefined ? call(method) : call(method, arg);
  },
  on: listen,
  // 이 애플리케이션이 서비스하는 문서의 경로. 표면도 같은 자산 서버에서 로드된다.
  page: (path) => `/${path}`,
  // 제목 표시줄이 투명하고 콘텐츠가 그 아래까지 차지하므로, 끄는 자리를 이 문서가
  // 지정한다.
  draggable(el) {
    el.style.setProperty("--wails-draggable", "drag");
  },
};

export const page = (() => {
  const call = (method, ...args) => window.__soksakNative.call(method, args);
  const listen = (event, fn) => window.__soksakNative.on(event, fn);
  return {
    theme(fn) {
      call("Theme").then(fn);
      listen("theme", fn);
    },
    shell: {
      open: (id) => call("ShellOpen", id),
      write: (id, text) => call("ShellWrite", id, text),
      onOutput(id, fn) {
        // 출력 이벤트는 모든 페이지가 받는다. id 가 일치하는 것만 처리한다.
        listen("shell-output", (out) => {
          if (out.id === id) fn(out.text);
        });
      },
    },
    modal: {
      content(id, instance, fn, place) {
        return Promise.all([listen("modal-content", (sent) => {
          if (sent.id === id && sent.instance === instance) fn(sent.content);
        }), listen("modal-position", (sent) => {
          if (sent.id === id && sent.instance === instance) place(sent.card);
        })]).then(() => call("ModalContent", id, instance)).then(fn);
      },
      ready: (id, instance) => call("ModalReady", id, instance),
      answer: (id, instance, key, value) => call("OverlayPick", id, instance, key, value),
    },
  };
})();

/** 설정과 프로젝트 목록은 네이티브 호스트가 저장한다. */
export const openStore = async () => new HostWorkspaceStore(host);
