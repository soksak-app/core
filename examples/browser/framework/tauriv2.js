// Tauri v2.
//
// 커맨드를 이름으로 부르고, 다리를 페이지 스크립트보다 먼저 넣어 준다. 그래서
// 기다릴 것이 없다.
//
// 표면과 모달의 페이지도 이 앱 자신의 문서이므로 같은 다리를 쓴다.

export const name = "tauriv2";

/** Tauri 는 자기 다리를 이 이름으로 창에 넣는다. */
export const present = () => Boolean(window.__TAURI__);

const COMMAND = {
  syncSurfaces: "sync_surfaces",
  setTheme: "set_theme",
  report: "report",
  overlayShow: "overlay_show",
  overlayPlace: "overlay_place",
  overlayUpdate: "overlay_update",
  overlayHide: "overlay_hide",
};

// 커맨드마다 인자의 이름이 다르다. 이름은 Rust 쪽 서명이 정한다.
const ARG = {
  syncSurfaces: (v) => ({ request: v }),
  setTheme: (v) => ({ theme: v }),
  report: (v) => ({ line: v }),
  overlayShow: (v) => ({ request: v }),
  overlayPlace: (v) => ({ request: v }),
  overlayUpdate: (v) => ({ request: v }),
  overlayHide: (v) => ({ id: v }),
};

export const host = () => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  return {
    ready: (fn) => fn(),
    call(name, arg) {
      const command = COMMAND[name];
      if (!command) return Promise.reject(new Error(`unknown host call: ${name}`));
      return invoke(command, ARG[name](arg));
    },
    // 사건은 실린 것을 `payload` 로 나른다. 그 밖의 것은 없다.
    on: (event, fn) => listen(event, (e) => fn(e.payload)),
    // 이 앱의 문서에는 다리가 이미 들어 있지만, 이름을 함께 실어 보내는 규칙은
    // 하나로 둔다 — 프레임워크마다 다르면 그 차이를 매번 기억해야 한다.
    page: (path) => `${path}${path.includes("?") ? "&" : "?"}framework=${name}`,
  };
};

export const page = () => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  return {
    theme(fn) {
      invoke("theme").then(fn);
      listen("theme", (e) => fn(e.payload));
    },
    shell: {
      open: (id) => invoke("terminal_open", { id }),
      write: (id, text) => invoke("terminal_write", { id, data: text }),
      onOutput(id, fn) {
        listen("terminal-output", (e) => { if (e.payload.id === id) fn(e.payload.text); });
      },
    },
    modal: {
      content(id, fn) {
        invoke("overlay_content", { id }).then(fn);
        listen("overlay-content", (e) => fn(e.payload));
      },
      fit: (id, w, h) => invoke("overlay_fit", { id, w, h }),
      answer: (id, key, value) => invoke("overlay_pick", { key, value }),
    },
  };
};
