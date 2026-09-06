// Wails v3.
//
// 메인 페이지와 표면·모달 페이지가 모두 이 애플리케이션의 문서다. 셋 다 같은 스킴에서
// 로드되고, 같은 런타임을 import 하고, 같은 이벤트를 구독한다.
//
// 바인딩된 메서드를 「패키지 · 타입 · 이름」으로 호출한다. 이 서비스는 이름을
// 지정하지 않으므로 Wails 가 패키지와 타입 이름을 쓴다 — main 의 Surfaces 다.
//
// 런타임은 /wails/runtime.js 의 ES 모듈이므로 script 태그가 아니라 import 로
// 로드한다. import 는 비동기이므로 아래 두 인터페이스는 완료를 기다린 뒤 호출한다.

/** Wails 는 이 애플리케이션의 모든 문서를 이 스킴에서 로드한다. */
export const present = () => location.protocol === "wails:";

const SERVICE = "main.Surfaces";

/* 런타임 모듈. import 는 한 번만 평가된다. */
const runtime = () => import("/wails/runtime.js");

/** 바인딩된 메서드 호출. */
const call = (method, ...args) =>
  runtime().then((r) => r.Call.ByName(`${SERVICE}.${method}`, ...args));

/** 이벤트 수신. payload 는 `data` 필드에 담긴다. */
const listen = (event, fn) =>
  runtime().then((r) => r.Events.On(event, (e) => fn(e.data)));

const METHOD = {
  syncSurfaces: "SyncSurfaces",
  setTheme: "SetTheme",
  report: "Report",
  overlayShow: "OverlayShow",
  overlayPlace: "OverlayPlace",
  setShape: "SetShape",
  clearShape: "ClearShape",
  overlayUpdate: "OverlayUpdate",
  overlayHide: "OverlayHide",
};

export const host = () => ({
  call(name, arg) {
    const method = METHOD[name];
    if (!method) return Promise.reject(new Error(`unknown host call: ${name}`));
    return call(method, arg);
  },
  on: listen,
  // 이 애플리케이션이 서비스하는 문서의 경로. 표면도 같은 자산 서버에서 로드된다.
  page: (path) => `/${path}`,
  // 창에 프레임이 없으므로 끄는 자리를 이 문서가 지정한다.
  draggable(el) {
    el.style.setProperty("--wails-draggable", "drag");
  },
  window: {
    close: () => runtime().then((r) => r.Window.Close()),
    minimise: () => runtime().then((r) => r.Window.Minimise()),
    toggleMaximise: () => runtime().then((r) => r.Window.ToggleMaximise()),
  },
});

export const page = () => ({
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
    content(id, fn) {
      call("ModalContent", id).then(fn);
      listen("modal-content", (sent) => {
        if (sent.id === id) fn(sent.content);
      });
    },
    ready: (id) => call("ModalReady", id),
    answer: (id, key, value) => call("OverlayPick", id, key, value),
  },
});
