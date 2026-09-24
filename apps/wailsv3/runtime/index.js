// Wails v3.
//
// 메인 페이지는 Wails 런타임을, 추가 웹뷰는 앱의 네이티브 브리지를 사용한다.
// 웹뷰 설정의 자산 서버를 공유하므로 문서는 같은 스킴에서 로드된다.
//
// 바인딩된 메서드를 「패키지 · 타입 · 이름」으로 호출한다. Wails 는 호스트 패키지의
// 가져오기 경로와 타입 이름인 github.com/min-median-max/soksak/packages/host/wailsv3/src.Host 를 사용한다.
//
// 런타임은 /wails/runtime.js 의 ES 모듈이므로 script 태그가 아니라 import 로
// 로드한다. import 는 비동기이므로 아래 두 인터페이스는 완료를 기다린 뒤 호출한다.
import { HostWorkspaceStore } from "@soksak/workbench/host-store.js";
import { hostWindows } from "@soksak/workbench/host-windows.js";
import { createClipboardBridge } from "@soksak/plugin-api";

const SERVICE = "github.com/min-median-max/soksak/packages/host/wailsv3/src.Host";

/* 런타임 모듈. import 는 한 번만 평가된다. */
const runtime = () => import("/wails/runtime.js");

/** 바인딩된 메서드 호출. */
const call = (method, ...args) =>
  window.__soksakNative?.call
    ? Promise.resolve(window.__soksakNative.call(method, args))
    : runtime().then((r) => r.Call.ByName(`${SERVICE}.${method}`, ...args));

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
  waitPresented: "WaitPresented",
  setTheme: "SetTheme",
  theme: "Theme",
  report: "Report",
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
  compositionDeclare: "CompositionDeclare",
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
  documentDetach: "DocumentDetach",
  sidecarSend: "SidecarSend",
  clipboardRead: "ClipboardRead",
  clipboardWriteText: "ClipboardWriteText",
  clipboardPersistPNG: "ClipboardPersistPNG",
};

export const host = {
  call(name, arg) {
    const method = METHOD[name];
    if (!method) return Promise.reject(new Error(`unknown host call: ${name}`));
    // 인자가 없는 호출은 인자를 보내지 않는다. undefined 를 하나 보내면 바인딩이
    // 인자 수가 맞지 않는다고 거절한다.
    if (name === "sidecarSend") return call(method, arg.sidecar, arg.surface, arg.body);
    if (name === "report") {
      if (typeof arg !== "string") return Promise.reject(new TypeError("report requires a string"));
      return call(method, arg);
    }
    if (name === "imageCaret") return call(method, { surface: arg.surface, name: arg.name }, arg.x, arg.y, arg.width, arg.height);
    if (name === "imageText") return call(method, { surface: arg.surface, name: arg.name }, arg.text);
    return arg === undefined ? call(method) : call(method, arg);
  },
  on: listen,
  // 제목 표시줄이 투명하고 콘텐츠가 그 아래까지 차지하므로, 끄는 자리를 이 문서가
  // 지정한다.
  draggable(el) {
    el.style.setProperty("--wails-draggable", "drag");
  },
};

export const clipboard = createClipboardBridge((name, payload) => host.call(name, payload), { allowPersist: true });

export const page = (() => {
  const call = (method, ...args) => window.__soksakNative.call(method, args);
  const listen = (event, fn) => window.__soksakNative.on(event, fn);
  // 표면 id 는 문서 주소의 id 다. 워크벤치가 표면을 그 탭 id 로 연다.
  const surface = new URLSearchParams(location.search).get("id");
  return {
    theme(fn) {
      call("Theme").then(fn);
      listen("theme", fn);
    },
    sidecar: (name) => ({
      send: (surface, body) => call("SidecarSend", name, surface, body),
      // 사이드카 이벤트는 창의 모든 페이지가 받는다. 사이드카와 표면이 일치하는 것만 처리한다.
      on: (surface, fn) => listen("sidecar-message", (message) => {
        if (message.sidecar === name && message.surface === surface) fn(message.body);
      }),
    }),
    // 공개 항목의 등록과 요청. 요청 이벤트에 surface 가 있으면 이 표면의 것만 처리한다.
    exposure: {
      register: (kind, name) => call("ExposureRegister", { surface, kind, name }),
      onRequest: (fn) => listen("exposure-request", (request) => {
        if (request.surface === undefined || request.surface === surface) fn(request);
      }),
      reply: (id, payload) => call("ExposureReply", { id, ...payload }),
    },
    // 이 표면의 문서 영역. 호스트는 호출한 웹뷰가 surface 인지 확인하고 상태를 이 표면에만 보낸다.
    document: {
      attach: (document) => call("DocumentAttach", { surface, document }),
      load: (document, url) => call("DocumentLoad", { surface, document, url }),
      zoom: (document, zoom) => call("DocumentZoom", { surface, document, zoom }),
      go: (document, action) => call("DocumentGo", { surface, document, action }),
      detach: (document) => call("DocumentDetach", { surface, document }),
      onState: (fn) => listen("document-state", (sent) => {
        if (sent.surface === surface) fn(sent.document, sent.state);
      }),
    },
    // 이 표면의 그림 영역. 호스트는 호출한 웹뷰가 surface 인지 확인하고 이벤트를 이 표면에만 보낸다.
    image: {
      attach: (name, sidecar) => call("ImageAttach", { surface, name, sidecar }),
      focus: (name) => call("ImageFocus", { surface, name }),
      caret: (name, x, y, w, h) => call("ImageCaret", { surface, name }, x, y, w, h),
      text: (name, text) => call("ImageText", { surface, name }, text),
      detach: (name) => call("ImageDetach", { surface, name }),
      on: (fn) => listen("image-event", (sent) => {
        if (sent.surface === surface) fn(sent.name, sent.event);
      }),
    },
    composition: {
      place: (revision, regions, overlays) =>
        call("CompositionPlace", { surface, revision, regions, overlays }),
    },
    modal: {
      content(id, instance, fn, place) {
        return Promise.all([listen("modal-content", (sent) => {
          if (sent.id === id && sent.instance === instance) fn({ revision: sent.revision, content: sent.content });
        }), listen("modal-position", (sent) => {
          if (sent.id === id && sent.instance === instance) place({ revision: sent.revision, card: sent.card });
        })]).then(() => call("ModalContent", id, instance)).then(fn);
      },
      ready: (id, instance) => call("ModalReady", id, instance),
      answer: (id, instance, key, value) => call("OverlayPick", id, instance, key, value),
    },
  };
})();

/** 설정과 프로젝트 목록은 네이티브 호스트가 저장한다. */
export const openStore = async () => new HostWorkspaceStore(host);

/** 창과 프로젝트 폴더는 네이티브 호스트가 관리한다. */
export const windows = hostWindows(host);
