// 네이티브 표면과 모달 뷰를 애플리케이션에 요청한다.
//
// 페이지는 커밋마다 표면의 프레임을 선언하고 호스트가 각각을 웹뷰로 만든다.
// 브라우저 표면은 외부 URL 을, 터미널 표면은 이 호스트가 서비스하는 문서를
// 표시하고 셸 프로세스를 연결한다.
//
// DOM 은 네이티브 뷰 위에 그릴 수 없으므로 [data-native-modal] 요소는 별도 뷰에
// 렌더링한다. 그 뷰는 애플리케이션의 창에 자식 창으로 붙으므로 표면 위에 그려진다.
//
// 이 파일은 애플리케이션마다 복제하지 않는다. 애플리케이션별 차이는 전송 방식뿐이고
// framework/ 가 담당한다.
import { host as bridge } from "./framework/index.js";
import { plugins } from "./plugins/registry.js";

/** 표면이 표시할 대상을 URL 로 변환한다. `url` 은 외부, `page` 는 이 호스트의 문서. */
function surfaceURL(surface) {
  if (surface.url) return surface.url;
  if (surface.page) return bridge.page(surface.page);
  throw new Error(`surface declares neither url nor page: ${JSON.stringify(surface)}`);
}

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

/** 표면이 문서를 렌더링하기 전까지 표시할 색을 반환한다. */
function surfaceBackground() {
  const probe = document.createElement("div");
  probe.style.color = "var(--surface)";
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+/g);
  probe.remove();
  return [Number(rgb[0]), Number(rgb[1]), Number(rgb[2])];
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
    className: el.className,
    html: el.innerHTML,
    css: [...document.styleSheets]
      .map((sheet) => [...sheet.cssRules].map((rule) => rule.cssText).join("\n"))
      .join("\n"),
    border: over(style.borderTopColor, style.backgroundColor),
  };
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
 * 호출과 그 답을 애플리케이션 로그에 남길지 여부.
 *
 * 관측 부품이 요청할 때만 켠다. 기록기가 이 파일에 있으므로 두 애플리케이션이 같은
 * 형식으로 남기고, 형식이 서로 어긋날 수 없다.
 */
let recording = false;

/* 애플리케이션에는 콘솔이 없다. 여기서 실패를 잡으면 기록되지 않으므로 잡지
   않는다. 문서의 unhandledrejection 이 애플리케이션 로그로 전달한다. */
const tell = (name, payload) => {
  const answered = bridge.call(name, payload);
  // report 자신은 남기지 않는다. 남기면 그 기록이 다시 기록을 부른다.
  if (recording && name !== "report") {
    Promise.resolve(answered).then((answer) => {
      bridge.call("report", `host ${name} ${say(payload)} -> ${say(answer)}`);
    // 실패한 호출은 tellInTurn 이 보고한다. 여기서 받지 않으면 그 실패가 처리되지
    // 않은 거절이 되어, 기록을 켰을 때만 같은 실패가 두 번 남는다.
    }, () => {});
  }
  return answered;
};

/**
 * 기록 한 줄에 담기는 값.
 *
 * 답이 없는 호출을 한 가지로 적는다. 프레임워크마다 빈 답의 모양이 달라, 그대로
 * 적으면 답이 없다는 같은 사실이 서로 다르게 남는다.
 */
const say = (value) => {
  const empty = value == null ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
  return empty ? "null" : JSON.stringify(value);
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
      // 표면마다 읽지 않는다. 값은 테마가 정하고 표면마다 같으며, 읽을 때마다
      // 문서에 요소를 붙였다 떼고 스타일을 다시 계산하게 한다.
      const background = surfaceBackground();
      const surfaces = record.surfaces.map((s) => ({
        id: s.id,
        dim: s.dim,
        url: surfaceURL(s.surface),
        // URL 이 이 호스트 외부인지 여부. 애플리케이션은 외부 주소를 그대로 열고
        // 자체 문서는 자기 서버로 연다. 표면의 종류는 알 필요가 없다.
        external: !!s.surface.url,
        visible: s.visible,
        // 문서를 로드하기 전에 표시할 색. 렌더링 후 뷰가 커져 드러난 영역에는
        // 적용되지 않는다.
        background,
        ...toPage(s.applied),
      }));

      // place 는 렌더마다 호출되고 divider 드래그 중에는 매 프레임 호출된다.
      // 직전과 같은 요청은 전송하지 않는다.
      const request = {
        // 마지막 갱신인지, 갱신이 이어지는 중인지. 이어지는 동안 뷰가 커지면
        // 아직 렌더링되지 않은 영역이 흰색으로 보인다.
        settled: record.settled !== false,
        surfaces,
      };
      const key = JSON.stringify(request);
      if (key === last) return;
      last = key;
      // 차례대로 보낸다. 애플리케이션에 따라 호출마다 다른 스레드에서 처리되므로,
      // 기다리지 않으면 한 프레임 전의 자리가 나중에 적용된다.
      // 애플리케이션이 실제로 앉힌 자리를 판 기준으로 되돌려 답한다. 렌더링 전에
      // 배치를 보낸 쪽이 이 결과를 기다린다.
      return tellInTurn("syncSurfaces", request).then((placed) =>
        (placed ?? []).map((p) => ({ id: p.id, ...toPlane(p) })));
    },
} : {
  kinds: [],
  report: () => {},
  theme: () => {},
  place: () => {},
};

let pick = null;
let shown = null;

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
  // 관측 부품이 기록을 요청한다. 요청하지 않으면 한 줄도 남지 않는다.
  bridge.on("observe-record", () => { recording = true; });
  bridge.on("surface-pressed", (id) => onPress(id));
  bridge.on("surface-input", (step) => onInput(step));
  // 모달은 여러 번 응답하므로 여기서 구독을 해제하지 않고 hide 에서 해제한다.
  // 답에는 어느 모달의 것인지가 함께 온다. 닫힌 모달이 마지막으로 보낸 답이 다음
  // 모달의 수신자에게 가지 않도록 그것으로 거른다.
  bridge.on("overlay-pick", ({ id, key, value }) => {
    if (pick && id === shown) pick(key, value);
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
      if (!el.matches("[data-native-modal]")) {
        throw new Error(`${el.id || el.className} is not a [data-native-modal] element`);
      }
      // 뷰 이름은 요소 id 를 사용한다. id 가 없는 요소가 둘이면 같은 뷰를 공유한다.
      if (!el.id) throw new Error("a [data-native-modal] element needs an id");
      // 창은 그려지지 않는 제목도 갖는다. 시스템과 보조기술이 창을 부르는 이름이다.
      const name = el.getAttribute("aria-label");
      if (!name) throw new Error(`${el.id} needs an aria-label to name its window`);
      shown = el.id;
      const style = getComputedStyle(el);
      tellInTurn("overlayShow", {
        id: shown,
        title: name,
        rect: toPage(rect),
        ...drawing(el),
        radius: parseFloat(style.borderTopLeftRadius) || 0,
        background: rgba(style.backgroundColor),
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
      tellInTurn("overlayPlace", { id: shown, rect: toPage(rect) });
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
      if (id) tellInTurn("overlayHide", id);
    },
} : {
  show: () => {},
  place: () => {},
  update: () => {},
  hide: () => {},
};
