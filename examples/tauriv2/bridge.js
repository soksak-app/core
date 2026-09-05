// Tauri 로 가는 다리.
//
// Tauri 는 커맨드를 이름으로 부르고, 다리를 페이지 스크립트보다 먼저 넣어 준다.
// 그래서 기다릴 것이 없다.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const COMMAND = {
  syncSurfaces: "sync_surfaces",
  setTheme: "set_theme",
  report: "report",
  overlayShow: "overlay_show",
  overlayUpdate: "overlay_update",
  overlayHide: "overlay_hide",
};

// 커맨드마다 인자의 이름이 다르다. 이름은 Rust 쪽 서명이 정한다.
const ARG = {
  syncSurfaces: (v) => ({ request: v }),
  setTheme: (v) => ({ theme: v }),
  report: (v) => ({ line: v }),
  overlayShow: (v) => ({ request: v }),
  overlayUpdate: (v) => ({ request: v }),
  overlayHide: (v) => ({ id: v }),
};

const bridge = {
  ready(fn) { fn(); },
  call(name, arg) {
    const command = COMMAND[name];
    if (!command) return Promise.reject(new Error(`unknown host call: ${name}`));
    return invoke(command, ARG[name](arg));
  },
  // 사건은 실린 것을 `payload` 로 나른다. 그 밖의 것은 없다.
  on(event, fn) {
    listen(event, (e) => fn(e.payload));
  },
  // 이 호스트가 서비스하는 문서는 앱 자신의 문서다.
  page: (path) => path,
};
