// 네이티브 표면과 모달 뷰를 애플리케이션에 요청한다.
//
// 페이지는 커밋마다 표면의 프레임을 선언하고 호스트가 각각을 웹뷰로 만든다.
// 표면은 플러그인 패키지 안의, 이 호스트가 서비스하는 문서를 표시한다.
//
// DOM 은 네이티브 뷰 위에 그릴 수 없으므로 [data-native-modal] 요소는 별도 뷰에
// 렌더링한다. 그 뷰는 메인창 내부에 배치되어 표면 위에 그려진다.
//
// 이 파일은 애플리케이션마다 복제하지 않는다. 애플리케이션별 차이는 전송 방식뿐이고
// 런타임 모듈(@soksak/runtime)이 담당한다.
import { host as bridge } from "@soksak/runtime";
import { plugins } from "./registry.js";
import { createClipboardBridge, createExpose } from "@soksak/plugin-api";
import { registerSurfacePort, registry, unregisterSurfacePort } from "./exposure.js";

/**
 * 계산된 CSS 색을 [r, g, b, a] 로 반환한다. 알파가 없으면 1 이다.
 *
 * 브라우저는 color-mix 의 결과를 color(srgb r g b / a) 로 직렬화하고, 그 표기의
 * 채널은 0..1 이다. rgb() 표기의 채널은 0..255 이므로 눈금을 맞춘다. 호스트는 색을
 * 0..255 로 받는다.
 */
function rgba(css) {
  const text = String(css).trim();
  const n = (text.match(/[\d.]+/g) ?? []).map(Number);
  const unit = text.startsWith("color(") ? 255 : 1;
  return [(n[0] || 0) * unit, (n[1] || 0) * unit, (n[2] || 0) * unit, n[3] === undefined ? 1 : n[3]];
}

/**
 * colour 를 ground 위에 합성한 불투명 색을 반환한다.
 *
 * 페이지의 일부 색은 반투명이고 페이지 안에서는 판 위에 합성된다. 네이티브 모달은
 * 아래 표면 위에 합성되므로, 반투명 보더가 흰 페이지 위에서 사라진다.
 */
function over(colour, ground) {
  const [r, g, b, a] = rgba(colour);
  const [br, bg, bb] = rgba(ground);
  const mix = (c, d) => Math.round(c * a + d * (1 - a));
  return `rgb(${mix(r, br)}, ${mix(g, bg)}, ${mix(b, bb)})`;
}

/** 판 기준 사각형을 페이지 기준으로 변환한다. */
function toPage(rect) {
  const plane = document.getElementById("plane").getBoundingClientRect();
  return { x: plane.left + rect.x, y: plane.top + rect.y, w: rect.w, h: rect.h };
}

/** 페이지 기준 사각형을 판 기준으로 되돌린다. 애플리케이션은 페이지 좌표로 답한다. */
function toPlane(rect) {
  const plane = document.getElementById("plane").getBoundingClientRect();
  return { x: rect.x - plane.left, y: rect.y - plane.top, w: rect.w, h: rect.h };
}

/**
 * 모달 렌더링에 필요한 값. show 와 update 가 같은 형태를 전송한다.
 *
 * 스타일시트는 문서가 실제로 가진 규칙을 읽는다. `<style>` 요소만 모으면 링크로
 * 걸린 시트가 빠지고, 모달은 규칙 없는 마크업만 받는다.
 */
function drawing(el) {
  const style = getComputedStyle(el);
  return {
    mode: el.dataset.nativeModal,
    card: cardFrame(el),
    title: el.getAttribute("aria-label") || "",
    className: el.className,
    html: el.innerHTML,
    css: [...document.styleSheets]
      .filter((sheet) => !document.adoptedStyleSheets.includes(sheet))
      .map((sheet) => [...sheet.cssRules].map((rule) => rule.cssText).join("\n"))
      .join("\n"),
    border: over(style.borderTopColor, style.backgroundColor),
  };
}

function cardFrame(el) {
  const r = el.getBoundingClientRect();
  const dialog = el.dataset.nativeModal === "dialog";
  return { x: dialog ? r.left : 0, y: dialog ? r.top : 0, w: r.width, h: r.height };
}

function overlayFrame(el, rect) {
  return el.dataset.nativeModal === "dialog"
    ? { x: 0, y: 0, w: innerWidth, h: innerHeight }
    : toPage(rect);
}

/** 앱 DOM 모달을 통과한 네이티브 입력이 네이티브 표면에 전달되지 않게 한다. */
function windowOverlays() {
  if (!shown) return [];
  const el = document.getElementById(shown);
  if (!el || el.hidden) return [];
  if (el.dataset.nativeModal === "dialog") {
    return [{ x: 0, y: 0, w: innerWidth, h: innerHeight }];
  }
  const rect = el.getBoundingClientRect();
  return [{ x: rect.left, y: rect.top, w: rect.width, h: rect.height }];
}

/**
 * 이 페이지를 애플리케이션이 실행하는가.
 *
 * 표면과 모달과 도형을 누가 그리는지가 이 값으로 갈린다. 애플리케이션이 그리면
 * 네이티브 뷰이고, 아니면 이 문서가 DOM 으로 모사한다. 그리는 방법이 정말로 다르므로
 * 갈림 자체는 남고, 갈리는 자리는 이 값 하나다.
 */
export const native = Boolean(bridge);

/**
 * 네이티브 표면을 만들지 않고 선언된 background 세션 명령을 보낸다.
 * 탭 id를 사이드카 표면 키로 유지해 나중에 표시되는 표면이 같은 영속 actor에
 * 다시 연결되게 한다.
 */
export function windowSidecar(name) {
  if (!bridge) return null;
  return {
    send: (surface, body) => bridge.call("sidecarSend", { sidecar: name, surface, body }),
    on: (surface, listener) => Promise.resolve(bridge.on("sidecar-message", (event) => {
      if (event?.sidecar === name && event?.surface === surface) listener(event.body);
    })),
  };
}

/* 이 문서에 표면 모듈이 마운트되므로 모든 네이티브 연산은 호스트 경계를 넘기
   전에 명시적인 표면 범위로 제한한다. */
export function surfaceContextRuntime(surface, declarations = {}) {
  const surfaceId = surface.surfaceId ?? surface.id;
  const invoke = (name, payload) => name === "report"
    ? bridge.call(name, payload)
    : bridge.call(name, { ...(payload ?? {}), surface: surfaceId });
  const listeners = new Map();
  const on = (name, fn) => {
    let set = listeners.get(name);
    if (!set) listeners.set(name, set = new Set());
    set.add(fn);
    const registered = bridge.on(name, (event) => {
      if (event?.surface === surfaceId) fn(event);
    });
    return Promise.resolve(registered).then((off) => () => {
      set.delete(fn);
      off?.();
    });
  };
  const theme = (fn) => {
    if (typeof fn !== "function") throw new TypeError("surface theme requires a listener");
    const initial = bridge.call("theme").then(fn);
    const registration = bridge.on("theme", fn);
    return {
      ready: initial,
      dispose: Promise.resolve(registration),
    };
  };
  const port = {
    register: (kind, name) => registry.registered({ surface: surfaceId, kind, name }),
    onRequest: (fn) => registerSurfacePort(surfaceId, fn),
    reply: (id, payload) => bridge.call("exposureReply", { id, ...payload, surface: surfaceId }),
    unregister: () => {
      registry.unregisterSurface(surfaceId);
      unregisterSurfacePort(surfaceId, port);
    },
  };
  return {
    native: {
      call: invoke,
      on,
    },
    theme,
    call(name, payload) {
      if (name.includes(".")) {
        return registry.handle({ method: "command.run", params: { name, params: payload ?? {}, surface: surfaceId } })
          .then((reply) => reply.error ? Promise.reject(new Error(reply.error.message)) : reply.result);
      }
      return invoke(name, payload);
    },
    sidecar(name) {
      const declared = surface.sidecars ?? [];
      if (name !== undefined) throw new Error("surface runtime sidecar() does not accept a package name; use the declared sidecar");
      if (declared.length !== 1) throw new Error(`surface runtime requires exactly one declared sidecar, got ${declared.length}`);
      const sidecarName = declared[0];
      return {
        send: (id, body) => invoke("sidecarSend", { sidecar: sidecarName, surface: id, body }),
        on: (id, fn) => on("sidecar-message", (event) => {
          if (event.sidecar === sidecarName && event.surface === id) fn(event.body);
        }),
      };
    },
    exposure: createExpose(port, async () => {
      const core = registry.surfaceDeclarations();
      return {
        status: [...core.status, ...(declarations.status ?? [])],
        commands: [...core.commands, ...(declarations.commands ?? [])],
        dom: [...core.dom, ...(declarations.dom ?? [])],
      };
    }),
    clipboard: createClipboardBridge((name, payload) => invoke(name, payload), { allowPersist: true }),
  };
}

/* 호출과 그 답을 받는 함수. 진단 빌드의 진단 모듈만 설치한다. */
let watcher = null;

/**
 * 애플리케이션 호출을 fn(name, payload, answered) 로 알린다. answered 는 답의 promise 다.
 * fn 이 보내는 report 호출은 알리지 않는다.
 */
export function watchCalls(fn) {
  watcher = fn;
}

/** 줄 하나를 애플리케이션 로그로 보낸다. */
export const report = (line) => bridge.call("report", line);

/* 애플리케이션에는 콘솔이 없다. 여기서 실패를 잡으면 기록되지 않으므로 잡지
   않는다. 문서의 unhandledrejection 이 애플리케이션 로그로 전달한다. */
const tell = (name, payload) => {
  const answered = bridge.call(name, payload);
  // report 자신은 남기지 않는다. 남기면 그 기록이 다시 기록을 부른다.
  if (watcher && name !== "report") watcher(name, payload, answered);
  return answered;
};

/**
 * 앞선 호출이 끝난 뒤에 보낸다.
 *
 * 모달의 호출은 보낸 순서대로 적용되어야 한다. 창을 만드는 호출이 가장 느리고,
 * 애플리케이션에 따라 호출마다 다른 스레드에서 처리되므로, 기다리지 않으면 나중
 * 호출이 먼저 도착해 아직 없는 창을 옮기려 한다.
 */
let turn = Promise.resolve();
const tellInTurn = (name, payload) => {
  const answered = turn.then(() => tell(name, payload));
  // 실패해도 다음 호출은 보낸다. 그 실패를 여기서 삼키면 아무 데도 남지 않으므로
  // 애플리케이션 로그에 적는다.
  turn = answered.catch((why) => {
    bridge.call("report", `host ${name} failed: ${why}`);
  });
  return answered;
};

let last = "";
// 레이아웃 준비와 표시는 하나의 트랜잭션이다. 네이티브 합성기는 창마다 활성
// ticket 하나만 가지므로 두 호출 사이에 다음 준비 작업을 호스트로 보내지 않는다.
let layoutTurn = Promise.resolve();
let layoutFrame = layoutTurn;
let layoutResult = layoutTurn;

function continueAfterLayoutFailure(phase, error) {
  const message = `host ${phase} failed while advancing the layout queue: ${error?.message ?? error}`;
  bridge.call("report", message).then(undefined, (reportError) => {
    console.error(`${message}; reporting failed: ${reportError?.message ?? reportError}`);
  });
  return undefined;
}
let layoutPresented = false;

/**
 * 창 자체를 다루는 인터페이스. 애플리케이션이 없으면 null.
 *
 * 창의 프레임은 OS 가 그린다. 모서리, 그림자, 리사이즈, 단추를 이 예제가 다시
 * 만들지 않는다. 제목 표시줄만 투명하고 콘텐츠가 창 전체를 차지하므로, 창이 그리는
 * 단추가 페이지 위에 배치된다. 이 인터페이스는 그 영역과 끄는 영역을 담당한다.
 */
export const chrome = native ? {
  draggable: (el) => bridge.draggable(el),
  /** 창이 그리는 단추가 차지하는 영역. 단추를 그리지 않는 창이면 폭이 0 이다. */
  controls: () => tellInTurn("windowControls"),
} : null;

/** 표면 인터페이스. 애플리케이션이 없으면 아무 일도 하지 않는다. */
export const surfaces = native ? {
    /* 애플리케이션이 그리는 플러그인 종류. 표면을 가진 플러그인은 모두 여기서
       그리므로 등록소가 그 목록이다. 여기에 이름을 적으면 플러그인을 더할 때마다
       이 파일을 고쳐야 한다. */
    get kinds() {
      return plugins().map((p) => p.id);
    },

    /** 검증 결과 한 줄을 애플리케이션 로그로 전송한다. */
    report: (line) => tell("report", line),

    theme: (values) => tellInTurn("setTheme", values),

    place(record) {
      const surfaces = record.surfaces.map((s) => ({
        id: s.id,
        dim: s.dim,
        module: s.surface.module,
        composition: s.surface.composition,
        visible: s.visible,
        ...toPage(s.applied),
      }));

      // place 는 렌더마다 호출되고 divider 드래그 중에는 매 프레임 호출된다.
      // 직전과 같은 요청은 전송하지 않는다.
      const request = {
        // 마지막 갱신인지, 갱신이 이어지는 중인지. 이어지는 동안 뷰가 커지면
        // 아직 렌더링되지 않은 영역이 흰색으로 보인다.
        settled: record.settled !== false,
        overlays: windowOverlays(),
        surfaces,
      };
      const key = JSON.stringify(request);
      if (key !== last) {
        last = key;
        const scheduled = layoutTurn.then(() => tellInTurn("syncSurfaces", request));
        layoutFrame = scheduled;
        layoutResult = scheduled.then((frame) => frame.placements);
        layoutPresented = false;
        // 실패한 트랜잭션이 다음 독립 레이아웃을 막지 않게 한다.
        layoutTurn = scheduled.then(() => undefined, (error) => continueAfterLayoutFailure("syncSurfaces", error));
      }
      if (record.drawn && !layoutPresented) {
        const preparedLayout = layoutFrame;
        const presentedLayout = preparedLayout.then((frame) =>
          tellInTurn("presentSurfaces", { ...frame, settled: request.settled }));
        layoutResult = presentedLayout;
        layoutPresented = true;
        layoutTurn = presentedLayout.then(() => undefined, (error) => continueAfterLayoutFailure("presentSurfaces", error));
      }
      // 이전 ticket이 커밋되기 전에 새 동기화가 네이티브 ticket을 교체하지 않도록
      // 동기화와 표시 호출을 함께 처리한다.
      const result = layoutResult;
      return result.then((placed) =>
        placed.map((p) => ({ id: p.id, ...toPlane(p) }))).catch((error) => {
          if (result === layoutResult) { last = ""; layoutPresented = false; }
          throw error;
        });
    },
    // 표면 배치 RPC가 끝난 뒤에 호출해야 페이지가 네이티브 래스터 이벤트를 계속 처리할 수 있다.
    waitPresented: () => tell("waitPresented"),
} : {
  kinds: [],
  report: () => {},
  theme: () => {},
  place: () => {},
  waitPresented: async () => null,
};

let pick = null;
let shown = null;

/* 열린 모달 문서가 마지막으로 보고한 상태. docs/spec/exposure.md 의 core.modal 이다. */
let modalDocument = null;
const modalListeners = new Set();
const modalChanged = () => { for (const fn of modalListeners) fn(); };

/** 열린 모달과 그 문서가 보고한 상태. 열린 모달이 없으면 null 이다. */
export function modalState() {
  if (!shown) return null;
  const el = document.getElementById(shown);
  return { id: shown, mode: el?.dataset.nativeModal ?? null, document: modalDocument };
}

/** 모달 상태가 바뀌면 fn 을 호출한다. 해제 함수를 반환한다. */
export function onModalState(fn) {
  modalListeners.add(fn);
  return () => modalListeners.delete(fn);
}

/* 애플리케이션이 페이지로 보내는 입력의 수신자. 판이 등록한다. */
let onPress = () => {};
let onInput = () => {};

/**
 * 애플리케이션의 입력을 받을 함수를 등록한다.
 *
 *   press(id)   표면 위의 누름. 표면은 네이티브 뷰이므로 그 위의 클릭은 이 문서에
 *               도달하지 않는다. 애플리케이션이 표면 id 를 전달한다.
 *   input(step) 왼쪽 버튼의 누름, 이동, 놓음. 좌표는 이 문서의 것이다. divider 의
 *               잡는 영역은 통로보다 넓어서 통로가 선 하나 폭이면 그 영역 전체가
 *               표면 아래에 놓인다.
 */
export function onSurfaceInput({ press, input }) {
  onPress = press;
  onInput = input;
}

if (native) {
  bridge.on("surface-pressed", (id) => onPress(id));
  bridge.on("surface-input", (step) => onInput(step));
  // 모달은 여러 번 응답하므로 여기서 구독을 해제하지 않고 hide 에서 해제한다.
  // 답에는 어느 모달의 것인지가 함께 온다. 닫힌 모달이 마지막으로 보낸 답이 다음
  // 모달의 수신자에게 가지 않도록 그것으로 거른다.
  bridge.on("overlay-pick", ({ id, key, value }) => {
    if (id !== shown) return;
    // 모달 문서의 상태 보고는 응답이 아니다. 요소의 수신자에게 전달하지 않는다.
    if (key === "document") {
      modalDocument = JSON.parse(value);
      modalChanged();
      return;
    }
    if (pick) pick(key, value);
  });
}

/* 표면 위에 그리는 도형. 네이티브 뷰 하나이고 웹뷰가 아니다 — 채움과 선이 알파를
   갖고 표면이 보여주는 것 위에 합성된다. 웹뷰는 WebKit 이 자기 배경을 칠하므로
   그렇게 할 수 없다. */
export const shapes = native ? {
    set(id, rect, style) {
      tellInTurn("setShape", {
        id,
        rect: toPage(rect),
        radius: style.radius,
        lineWidth: style.lineWidth,
        fill: rgba(style.fill),
        line: rgba(style.line),
      });
    },

    clear: (id) => tellInTurn("clearShape", id),
} : {
  set: () => {},
  clear: () => {},
};

/**
 * 표면 위에 그리는 모달. 애플리케이션은 요소를 통째로 받아 자기 창에 그린다.
 *
 * conceal 은 이 문서의 요소를 감추는 방법이다. 요소마다 다르므로 부르는 쪽이 준다.
 * 애플리케이션이 없으면 감추지 않고 이 문서가 그대로 그린다.
 */
export const overlay = native ? {
    show(el, rect, onPick) {
      // 이 인터페이스는 한 번에 하나를 표시한다. 표시 중인 것을 닫지 않으면 그 창은
      // 애플리케이션에 남고 아무도 그것을 가리키지 않는다.
      if (shown) this.hide();
      pick = onPick;
      // 이 길로 오는 요소는 [data-native-modal] 이다. 표식만 두고 검사하지 않으면
      // 마크업과 동작이 따로 놀고, 표식 없는 요소가 조용히 뷰를 얻는다.
      if (!["dialog", "menu"].includes(el.dataset.nativeModal)) {
        throw new Error(`${el.id || el.className} needs data-native-modal="dialog" or "menu"`);
      }
      // 뷰 이름은 요소 id 를 사용한다. id 가 없는 요소가 둘이면 같은 뷰를 공유한다.
      if (!el.id) throw new Error("a [data-native-modal] element needs an id");
      // 보조기술이 오버레이를 부르는 이름이다.
      const name = el.getAttribute("aria-label");
      if (!name) throw new Error(`${el.id} needs an aria-label to name its overlay`);
      shown = el.id;
      modalDocument = null;
      modalChanged();
      const style = getComputedStyle(el);
      tellInTurn("overlayShow", {
        id: shown,
        title: name,
        rect: overlayFrame(el, rect),
        ...drawing(el),
        radius: el.dataset.nativeModal === "dialog" ? 0 : parseFloat(style.borderTopLeftRadius) || 0,
      });
    },

    /**
     * 이 요소의 모달 뷰의 위치를 갱신한다. 위치는 페이지가 결정한다.
     *
     * 표시 중인 것이 이 요소가 아니면 아무 일도 하지 않는다. 이 인터페이스는 한
     * 번에 하나를 표시하고, 자기 것이 아닌 창을 옮기거나 닫는 호출자는 다른
     * 기능의 창을 건드린다.
     */
    place(el, rect) {
      if (shown !== el.id) return;
      tellInTurn("overlayPlace", { id: shown, rect: overlayFrame(el, rect), card: cardFrame(el) });
    },

    /** 이 요소의 모달 뷰의 내용을 교체한다. 뷰를 다시 만들면 깜빡인다. */
    update(el) {
      if (shown !== el.id) return;
      tellInTurn("overlayUpdate", { id: shown, ...drawing(el) });
    },

    /** 이 요소의 모달 뷰를 닫는다. */
    hide(el) {
      if (el && shown !== el.id) return;
      const id = shown;
      shown = null;
      pick = null;
      modalDocument = null;
      modalChanged();
      if (id) tellInTurn("overlayHide", id);
    },
} : {
  show: () => {},
  place: () => {},
  update: () => {},
  hide: () => {},
};
