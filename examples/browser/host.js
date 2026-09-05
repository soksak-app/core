// 페이지에 진짜 네이티브 표면과, 모달을 그릴 네이티브 뷰를 준다.
//
// 페이지는 매 커밋마다 표면이 서야 할 프레임을 선언하고, 그 하나하나가 실제
// 웹뷰가 된다: 브라우저 판은 살아 있는 페이지를, 터미널 판은 이 호스트가
// 서비스하는 문서를 보여주고 그 뒤에 셸이 붙는다.
//
// 모달: DOM 은 네이티브 뷰 위에 그릴 수 없으므로 [data-native-modal] 요소는
// 자기 뷰로 넘긴다. 표면보다 나중에 만들어지므로 그 위에 선다.
//
// 이 파일은 어느 앱의 것도 아니다. 앱마다 다른 것은 전송 수단뿐이고, 그것은
// framework/ 가 내놓는다 — 계약이 같은데 파일이 둘이면 반드시 갈라진다.
import { host as bridge } from "./framework/index.js";

/** 표면이 보여주는 것을 주소로 바꾼다. `url` 은 이 호스트 밖, `page` 는 안. */
function surfaceURL(surface) {
  if (surface.url) return surface.url;
  if (surface.page) return bridge.page(surface.page);
  throw new Error(`surface declares neither url nor page: ${JSON.stringify(surface)}`);
}

/** 계산된 CSS 색의 네 채널. 알파가 없으면 불투명이다. */
function rgba(css) {
  const n = (css.match(/[\d.]+/g) ?? []).map(Number);
  return [n[0] || 0, n[1] || 0, n[2] || 0, n[3] === undefined ? 1 : n[3]];
}

/**
 * 한 색을 다른 색 위에 얹은, 불투명한 색.
 *
 * 페이지의 색들은 일부 투명해서 페이지 안에서는 뒤의 판 위에 얹힌다. 네이티브로
 * 그린 모달은 아래 표면이 보여주는 것 위에 얹히므로, 반투명한 보더는 흰
 * 페이지 위에서 씻겨 나간다.
 */
function over(colour, ground) {
  const [r, g, b, a] = rgba(colour);
  const [br, bg, bb] = rgba(ground);
  const mix = (c, d) => Math.round(c * a + d * (1 - a));
  return `rgb(${mix(r, br)}, ${mix(g, bg)}, ${mix(b, bb)})`;
}

/** 표면이 아직 자기 문서를 그리지 않은 동안 보여줄 색. */
function surfaceBackground() {
  const probe = document.createElement("div");
  probe.style.color = "var(--surface)";
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+/g) ?? [0, 0, 0];
  probe.remove();
  return [Number(rgb[0]), Number(rgb[1]), Number(rgb[2])];
}

/** 판 좌표로 받은 사각형을 페이지 좌표로. */
function toPage(rect) {
  const plane = document.getElementById("plane").getBoundingClientRect();
  return { x: plane.left + rect.x, y: plane.top + rect.y, w: rect.w, h: rect.h };
}

/** 모달 하나를 그리는 데 필요한 것. show 와 update 가 같은 것을 보낸다. */
function drawing(el) {
  const style = getComputedStyle(el);
  return {
    className: el.className,
    html: el.innerHTML,
    css: [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n"),
    border: over(style.borderTopColor, style.backgroundColor),
  };
}

function install() {
  let last = "";

  // 페이지는 이 호스트가 자리 잡기 전에 테마를 건다. 그래서 첫 공표가 테마를
  // 묻는 자리다 — 공표는 페이지가 섰다는 말이다.
  let announced = false;

  /* 앱에는 콘솔이 없다. 실패한 호출을 여기서 삼키면 그 실패는 아무 데도
     남지 않으므로, 잡지 않고 그대로 둔다 — 문서의 unhandledrejection 이
     받아서 앱의 로그로 보낸다. */
  const tell = (name, payload) => bridge.call(name, payload);

  window.hostSurfaces = {
    kinds: ["browser", "terminal"],

    /** 검사 결과 한 줄. 화면이 아니라 앱의 로그로 간다. */
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
        // 그 주소가 이 호스트 밖인가. 앱은 바깥 주소는 그대로 열고 자기 것은
        // 자기 서버로 열며, 어느 종류가 물었는지는 알 필요가 없다.
        external: !!s.surface.url,
        visible: s.visible,
        // 웹뷰는 아직 그리지 않은 자리를 흰색으로 둔다. divider 를 끌면 표면이
        // 매 프레임 크기가 바뀌므로 방금 드러난 띠가 흰색으로 번쩍인다. 표면
        // 색으로 시작하면 볼 흰색이 없다.
        background: surfaceBackground(),
        ...toPage(s.applied),
      }));

      // 공표는 매 렌더마다 온다. divider 를 끄는 매 프레임도 그렇다. 달라지지
      // 않은 요청을 보내는 것은 다리를 헛되이 건너는 일이다.
      const request = { viewport: { h: window.innerHeight }, surfaces };
      const key = JSON.stringify(request);
      if (key === last) return;
      last = key;
      tell("syncSurfaces", request);
    },
  };

  // 표면은 네이티브 뷰라 그 위의 누름이 이 문서에 닿지 않는다. 앱이 어느
  // 표면인지 알려 주면 페이지가 그 자리를 누른다 — 누름을 듣고 있는 것들이
  // 이미 아는 방식이다.
  bridge.on("surface-pressed", (id) => window.pressSurface(id));

  let pick = null;
  let shown = null;
  // 모달은 여러 번 답할 수 있다 — 고르기는 한 번이지만 설정은 바꿀 때마다다.
  // 듣는 것을 여기서 끊지 않는다. 끝났다고 말하는 것은 hide 다.
  bridge.on("overlay-pick", ({ key, value }) => { if (pick) pick(key, value); });

  window.hostOverlay = {
    show(el, rect, onPick) {
      pick = onPick;
      // 뷰는 요소의 이름을 따르므로, 이름 없는 요소는 뷰도 이름이 없다. 그런
      // 것이 둘이면 한 뷰를 나눠 쓰게 된다.
      if (!el.id) throw new Error("a [data-native-modal] element needs an id");
      shown = el.id;
      const style = getComputedStyle(el);
      tell("overlayShow", {
        id: shown,
        viewport: { h: window.innerHeight },
        rect: toPage(rect),
        ...drawing(el),
        radius: parseFloat(style.borderTopLeftRadius) || 0,
        background: rgba(style.backgroundColor).slice(0, 3),
      });
    },

    /** 열려 있는 모달을 옮긴다. 어디에 서는지는 페이지가 정한다. */
    place(rect) {
      if (!shown) return;
      tell("overlayPlace", { id: shown, viewport: { h: window.innerHeight }, rect: toPage(rect) });
    },

    /** 열려 있는 모달의 내용을 갈아 끼운다. 뷰를 새로 만들면 깜빡인다. */
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

// 다리가 없으면 호스트도 없다 — 브라우저에서는 페이지가 표면을 스스로 그린다.
if (bridge) bridge.ready(install);
