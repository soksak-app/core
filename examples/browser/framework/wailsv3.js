// Wails v3.
//
// 바인딩된 메서드를 「패키지 · 타입 · 이름」으로 호출한다. 패키지는 main 이고
// surfaces.go 의 ServiceName() 이 같은 값을 반환한다.
//
// 런타임은 /wails/runtime.js 의 ES 모듈이므로 script 태그가 아니라 import 로
// 불러온다.
//
// 표면과 모달 페이지는 네이티브 뷰에서 직접 실행되어 Go 바인딩을 사용할 수 없고,
// 애플리케이션이 띄운 루프백 서버로 요청한다. WKWebView 들이 네트워크 프로세스를
// 공유하며 호스트당 연결이 6개이므로, 테마는 별도 스트림 없이 셸 스트림으로
// 함께 전달한다.

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

const query = (id) => `?id=${encodeURIComponent(id)}`;

export const page = () => ({
  theme(fn) {
    fetch("/theme").then((r) => r.json()).then(fn);
  },
  shell: {
    open: (id) => fetch(`/terminal/open${query(id)}`, { method: "POST" }),
    write: (id, text) => fetch(`/terminal/write${query(id)}`, { method: "POST", body: text }),
    onOutput(id, fn, onTheme) {
      const stream = new EventSource(`/terminal/stream${query(id)}`);
      stream.addEventListener("output", (e) => fn(JSON.parse(e.data)));
      stream.addEventListener("theme", (e) => onTheme(JSON.parse(e.data)));
    },
  },
  modal: {
    content(id, fn) {
      fetch(`/overlay/content${query(id)}`).then((r) => r.json()).then(fn);
      new EventSource(`/overlay/stream${query(id)}`).onmessage = (e) => fn(JSON.parse(e.data));
    },
    fit: (id, w, h) => fetch(`/overlay/fit${query(id)}&w=${w}&h=${h}`, { method: "POST" }),
    answer: (id, key, value) =>
      fetch(`/overlay/pick${query(id)}&key=${encodeURIComponent(key)}` +
            `&value=${encodeURIComponent(value)}`, { method: "POST" }),
  },
});
