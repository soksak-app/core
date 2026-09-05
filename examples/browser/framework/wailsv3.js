// Wails v3.
//
// 바인딩된 메서드를 「패키지 · 타입 · 이름」으로 호출한다. 패키지는 main 이고
// surfaces.go 의 ServiceName() 이 같은 값을 반환한다.
//
// 런타임은 /wails/runtime.js 의 ES 모듈이므로 script 태그가 아니라 import 로
// 불러온다.
//
// 표면과 모달 페이지는 네이티브 뷰에서 직접 실행되어 Go 바인딩을 사용할 수 없다.
// 대신 뷰가 그 페이지에 메시지 채널을 주입한다(native_darwin.go). 루프백 서버는
// 문서를 내려주는 데만 쓴다 — 연결을 붙들고 있으면 표면이 늘수록 호스트당 연결
// 한도를 먹는다.

export const name = "wailsv3";

/**
 * Wails 는 창의 문서를 이 스킴으로 연다. 측정값은 `wails://localhost/`.
 *
 * `window.wails` 로는 판별할 수 없다. 그 객체는 런타임 import 이후에 생기고 이
 * 함수는 그 전에 호출된다.
 */
export const present = () => location.protocol === "wails:";

const SERVICE = "main.Surfaces";

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
  ready(fn) {
    import("/wails/runtime.js")
      .then(() => fn())
      .catch((e) => console.error("no Wails bridge", e));
  },
  call(name, arg) {
    const method = METHOD[name];
    if (!method) return Promise.reject(new Error(`unknown host call: ${name}`));
    return window.wails.Call.ByName(`${SERVICE}.${method}`, arg);
  },
  // 이벤트 payload 는 `data` 필드에 담긴다.
  on: (event, fn) => window.wails.Events.On(event, (e) => fn(e.data)),
  // 이 호스트가 서비스하는 문서 URL 에 런타임 이름을 추가한다. 그 문서는
  // wails:// 가 아니라 루프백 서버에서 실행되므로 주소로 판별할 수 없다.
  page: (path) => `/${path}${path.includes("?") ? "&" : "?"}framework=${name}`,
});

/* 페이지가 시작할 때 이미 갖고 있는 값. 뷰를 만들 때 주입되므로 가져오지 않는다. */
const boot = () => window.__spBoot;

/* 이 앱으로 가는 호출. 응답은 __spDeliver 로 돌아온다. */
const call = (name, arg) => window.__spCall(name, arg);

/* 앱이 보내는 것을 받을 함수를 건다. 이름 하나에 하나다. */
const on = (name, fn) => { window.__spOn[name] = fn; };

export const page = () => ({
  theme(fn) {
    if (boot()) fn(boot());
    on("theme", fn);
  },
  shell: {
    open: (id) => call("terminal.open", { id }),
    write: (id, text) => call("terminal.write", { id, text }),
    onOutput(id, fn) {
      on("output", fn);
    },
  },
  modal: {
    content(id, fn) {
      on("content", fn);
      call("overlay.content", { id });
    },
    fit: (id, w, h) => call("overlay.fit", { id, w, h }),
    answer: (id, key, value) => call("overlay.pick", { id, key, value }),
  },
});
