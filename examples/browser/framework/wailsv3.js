// Wails v3.
//
// 묶인 메서드를 「패키지 경로 · 타입 · 이름」으로 부른다. 여기 패키지는 main
// 이고, surfaces.go 의 ServiceName() 이 같은 것을 찍는다.
//
// 런타임은 /wails/runtime.js 의 ES 모듈이라 태그로 싣지 않고 가져온다.
//
// 표면과 모달의 페이지는 네이티브 뷰에 바로 실려 Go 로 가는 다리가 없다. 앱이
// 띄운 루프백 서버로 말한다. 그 서버로 가는 연결은 아껴 쓴다 — WKWebView 들이
// 네트워크 프로세스를 공유하고 호스트당 여섯 개다. 그래서 테마는 자기 스트림을
// 갖지 않고 셸의 스트림에 얹혀 온다.

export const name = "wailsv3";

/**
 * Wails 는 자기 창의 문서를 이 스킴으로 연다 (측정: `wails://localhost/`).
 *
 * `window.wails` 로는 판별할 수 없다 — 그것은 런타임을 가져온 뒤에 생기고,
 * 여기서는 그 전에 답해야 한다.
 */
export const present = () => location.protocol === "wails:";

const SERVICE = "main.Surfaces";

const METHOD = {
  syncSurfaces: "SyncSurfaces",
  setTheme: "SetTheme",
  report: "Report",
  overlayShow: "OverlayShow",
  overlayPlace: "OverlayPlace",
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
  // 사건은 실린 것을 `data` 로 나른다. 그 밖의 것은 없다.
  on: (event, fn) => window.wails.Events.On(event, (e) => fn(e.data)),
  // 이 호스트가 서비스하는 문서에는 자기 이름을 실어 보낸다 — 그 문서는
  // wails:// 가 아니라 루프백 서버에서 실리므로 주소만으로는 알 수 없다.
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
