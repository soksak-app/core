// 네이티브 표면과 모달 뷰를 애플리케이션에 요청한다.
//
// 페이지는 커밋마다 표면의 프레임을 선언하고 호스트가 각각을 웹뷰로 만든다.
// 브라우저 표면은 외부 URL 을, 터미널 표면은 이 호스트가 서비스하는 문서를
// 표시하고 셸 프로세스를 연결한다.
//
// DOM 은 네이티브 뷰 위에 그릴 수 없으므로 [data-native-modal] 요소는 별도 뷰에
// 렌더링한다. 표면보다 나중에 생성되므로 표면 위에 배치된다.
//
// 이 파일은 애플리케이션마다 복제하지 않는다. 애플리케이션별 차이는 전송 방식뿐이고
// framework/ 가 담당한다.
import { host as bridge } from "./framework/index.js";

/** 표면이 표시할 대상을 URL 로 변환한다. `url` 은 외부, `page` 는 이 호스트의 문서. */
function surfaceURL(surface) {
  if (surface.url) return surface.url;
  if (surface.page) return bridge.page(surface.page);
  throw new Error(`surface declares neither url nor page: ${JSON.stringify(surface)}`);
}

/** 계산된 CSS 색을 [r, g, b, a] 로 반환한다. 알파가 없으면 1 이다. */
function rgba(css) {
  const n = (css.match(/[\d.]+/g) ?? []).map(Number);
  return [n[0] || 0, n[1] || 0, n[2] || 0, n[3] === undefined ? 1 : n[3]];
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
  const rgb = getComputedStyle(probe).color.match(/\d+/g) ?? [0, 0, 0];
  probe.remove();
  return [Number(rgb[0]), Number(rgb[1]), Number(rgb[2])];
}

/** 판 기준 사각형을 페이지 기준으로 변환한다. */
function toPage(rect) {
  const plane = document.getElementById("plane").getBoundingClientRect();
  return { x: plane.left + rect.x, y: plane.top + rect.y, w: rect.w, h: rect.h };
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

function install() {
  let last = "";

  // 페이지는 이 호스트가 설치되기 전에 테마를 적용한다. 첫 place 호출에서 테마를
  // 한 번 전송한다.
  let announced = false;

  /* 애플리케이션에는 콘솔이 없다. 여기서 실패를 잡으면 기록되지 않으므로 잡지
     않는다. 문서의 unhandledrejection 이 애플리케이션 로그로 전달한다. */
  const tell = (name, payload) => bridge.call(name, payload);

  window.hostSurfaces = {
    kinds: ["browser", "terminal"],

    /** 검증 결과 한 줄을 애플리케이션 로그로 전송한다. */
    report: (line) => tell("report", line),

    theme: (values) => tell("setTheme", values),

    place(record) {
      if (!announced) {
        announced = true;
        this.theme(window.pageTheme());
      }
      const surfaces = record.surfaces.map((s) => ({
        id: s.id,
        dim: s.dim,
        url: surfaceURL(s.surface),
        // URL 이 이 호스트 외부인지 여부. 애플리케이션은 외부 주소를 그대로 열고
        // 자체 문서는 자기 서버로 연다. 표면의 종류는 알 필요가 없다.
        external: !!s.surface.url,
        visible: s.visible,
        // 문서를 아직 받지 못한 뷰가 표시할 색. 이미 그린 뒤 뷰가 커져서 드러난
        // 자리는 이 값으로 칠해지지 않는다 — 그 자리는 웹뷰 자신의 흰 배경이고
        // 그것을 끄는 키는 비공개다. 그래서 끄는 동안에는 뷰를 키우지 않는다.
        background: surfaceBackground(),
        ...toPage(s.applied),
      }));

      // place 는 렌더마다 호출되고 divider 드래그 중에는 매 프레임 호출된다.
      // 직전과 같은 요청은 전송하지 않는다.
      const request = {
        viewport: { h: window.innerHeight },
        // 이것이 최종 상태인지, 곧 다음 것이 이어지는지. 이어지는 동안 뷰를 키우면
        // 아직 그리지 못한 자리가 드러나고 그 자리는 흰색이다.
        settled: record.settled !== false,
        surfaces,
      };
      const key = JSON.stringify(request);
      if (key === last) return;
      last = key;
      tell("syncSurfaces", request);
    },
  };

  // 표면은 네이티브 뷰이므로 그 위의 클릭이 이 문서에 도달하지 않는다.
  // 애플리케이션이 표면 id 를 전달하면 페이지가 해당 슬롯에 pointerdown 을 낸다.
  bridge.on("surface-pressed", (id) => window.pressSurface(id));

  // 왼쪽 버튼의 누름, 이동, 놓음. 좌표는 이 문서의 것이다. divider 의 잡는 영역은
  // 통로보다 넓어서 통로가 선 하나 폭이면 그 영역 전체가 표면 아래에 놓인다.
  bridge.on("surface-input", (step) => window.surfaceInput(step));

  let pick = null;
  let shown = null;
  // 모달은 여러 번 응답하므로 여기서 구독을 해제하지 않고 hide 에서 해제한다.
  bridge.on("overlay-pick", ({ key, value }) => { if (pick) pick(key, value); });

  /* 표면 위에 그리는 도형. 네이티브 뷰 하나이고 웹뷰가 아니다 — 채움과 선이
     알파를 갖고 표면이 보여주는 것 위에 합성된다. 웹뷰는 WebKit 이 자기 배경을
     칠하므로 그렇게 할 수 없다. */
  window.hostShapes = {
    set(id, rect, style) {
      tell("setShape", {
        id,
        viewport: { h: window.innerHeight },
        rect: toPage(rect),
        radius: style.radius,
        lineWidth: style.lineWidth,
        fill: rgba(style.fill),
        line: rgba(style.line),
      });
    },

    clear: (id) => tell("clearShape", id),
  };

  window.hostOverlay = {
    show(el, rect, onPick) {
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
      tell("overlayShow", {
        id: shown,
        title: name,
        viewport: { h: window.innerHeight },
        rect: toPage(rect),
        ...drawing(el),
        radius: parseFloat(style.borderTopLeftRadius) || 0,
        background: rgba(style.backgroundColor),
      });
    },

    /** 열려 있는 모달 뷰의 위치를 갱신한다. 위치는 페이지가 결정한다. */
    place(rect) {
      if (!shown) return;
      tell("overlayPlace", { id: shown, viewport: { h: window.innerHeight }, rect: toPage(rect) });
    },

    /** 열려 있는 모달 뷰의 내용을 교체한다. 뷰를 다시 만들면 깜빡인다. */
    update(el) {
      if (!shown) return;
      tell("overlayUpdate", { id: shown, ...drawing(el) });
    },

    hide() {
      const id = shown;
      shown = null;
      pick = null;
      if (id) tell("overlayHide", id);
    },
  };
}

// 인터페이스가 없으면 호스트도 없다. 브라우저에서는 페이지가 표면을 직접 그린다.
if (bridge) bridge.ready(install);
