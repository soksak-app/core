// Wails 로 가는 다리.
//
// Wails 는 묶인 메서드를 「패키지 경로 · 타입 · 이름」으로 부른다. 여기 패키지는
// main 이고, surfaces.go 의 ServiceName() 이 같은 것을 찍는다.
//
// 런타임은 /wails/runtime.js 의 ES 모듈이라 태그로 싣지 않고 가져온다. 그래야
// 페이지의 html 에 Wails 의 것이 하나도 들어가지 않는다.

const SERVICE = "main.Surfaces";

const METHOD = {
  syncSurfaces: "SyncSurfaces",
  setTheme: "SetTheme",
  report: "Report",
  overlayShow: "OverlayShow",
  overlayUpdate: "OverlayUpdate",
  overlayHide: "OverlayHide",
};

const bridge = {
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
  on(event, fn) {
    window.wails.Events.On(event, (e) => fn(e.data));
  },
  // 이 호스트가 서비스하는 문서는 자기 서버의 루트 아래에 있다.
  page: (path) => `/${path}`,
};
