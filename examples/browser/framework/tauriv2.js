// Tauri v2.
//
// 커맨드를 이름으로 호출한다. Tauri 가 페이지 스크립트보다 먼저 인터페이스를
// 주입하므로 대기가 필요 없다. 표면과 모달 페이지도 같은 인터페이스를 사용한다.

export const name = "tauriv2";

/** Tauri 가 주입하는 전역 객체의 이름으로 판별한다. */
export const present = () => Boolean(window.__TAURI__);

const COMMAND = {
  syncSurfaces: "sync_surfaces",
  setTheme: "set_theme",
  report: "report",
  overlayShow: "overlay_show",
  overlayPlace: "overlay_place",
  setShape: "set_shape",
  clearShape: "clear_shape",
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
  setShape: (v) => ({ request: v }),
  clearShape: (v) => ({ id: v }),
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
      ready: (id) => invoke("overlay_ready", { id }),
      answer: (id, key, value) => invoke("overlay_pick", { key, value }),
    },
  };
};
