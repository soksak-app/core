// 메인 문서(index.html)의 오류 표시와 배치 배선. 배치 대기열이 판의 배치, 판이 없는 창의 첫 행, 프로젝트 전환의 빈 판을
// 하나씩 표시하고, 그 실패를 받아 오류 표시로 보인다. 그 배치를 기다리는 프로젝트 전환과 코어 명령은 같은 실패를 다시
// 쓰지 않는다(docs/spec/hosts.md#application-log). 문서, 호스트, 판, 컴포지터는 호출자가 넘긴다.
import { animationFrame, createLayoutQueue, drawPrepared } from "./layout-queue.js";
import { frameLayout } from "./frame-text.js";
import { trace } from "./performance.js";
import { showError as showShownError } from "./shown-errors.js";

/**
 * 메인 문서의 오류 배너에 오류를 보이는 함수를 만든다. 보이는 순간 기록한다(shown-errors.js). 배너가 없으면 header
 * 뒤에 만든다.
 *
 *   document  메인 문서
 *   changed   코어 상태가 바뀌었음을 알린다(core-exposure.js 의 coreChanged)
 */
export function createErrorDisplay({ document, changed }) {
  return function showError(reason, detail = "") {
    let el = document.getElementById("applicationError");
    if (!el) {
      el = document.createElement("div");
      el.id = "applicationError";
      el.setAttribute("role", "alert");
      document.querySelector("header").after(el);
    }
    showShownError(el, "page", String(reason), detail);
    changed();
  };
}

/**
 * 처리되지 않은 오류를 보이고 애플리케이션 로그로 보낸다. 애플리케이션에는 콘솔이 없다. 위치와 stack 은 로그에만 남긴다.
 *
 *   target     error 와 unhandledrejection 사건을 받는 창
 *   showError  createErrorDisplay 의 함수
 */
export function reportUncaught(target, showError) {
  target.addEventListener("error", (e) => showError(e.message, ` @ ${e.filename}:${e.lineno}`));
  target.addEventListener("unhandledrejection", (e) => {
    // 기본값: rejection 값이 Error 가 아니면 stack 이 없다.
    const stack = e.reason instanceof Error && e.reason.stack ? `\n${e.reason.stack}` : "";
    showError(e.reason instanceof Error ? e.reason.message : e.reason, stack);
  });
}

/**
 * 메인 문서의 배치 대기열과 그 배치를 예약하고 기다리는 함수를 만든다.
 *
 *   document   슬롯을 읽는 메인 문서
 *   showError  createErrorDisplay 의 함수
 *   setVerify, log  검증 행과 관측 줄을 받는다(core-exposure.js, host.js)
 *   surfaces   호스트의 표면 인터페이스(host.js 의 surfaces). waitPresented 를 쓴다
 *   plane      { currentGrid, settle, clear }(plane.js)
 *   compositor { publishAhead, publish }(compositor.js)
 *   textSize   지금 설정의 프레임 배율
 *   rendered   마지막 렌더가 커밋한 표시의 promise(index.html 의 onRender)
 *   waitSurfaceCompositionDeclared  표면 모듈의 합성 선언을 기다린다(surface-modules.js)
 */
export function createPageLayout({
  document, showError, setVerify, log, surfaces, plane, compositor, textSize, rendered, waitSurfaceCompositionDeclared,
}) {
  let failure = null;
  /* 표시되기 전에 더 새 배치로 대신된 배치의 수. 움직임이 멈춘 표시에서 애플리케이션 로그에
     한 줄로 남긴다. 움직이는 동안 배치마다 호스트를 부르면 표시가 그만큼 늦어진다. */
  let supersededLayouts = 0;
  const layouts = createLayoutQueue({
    failed(error) {
      failure = error;
      // 기본값: Error 가 아닌 거절은 그 값 자체를 문자열로 보인다.
      const message = String(error?.message ?? error);
      console.error(`surface presentation failed: ${message}`);
      showError(`surface presentation failed: ${message}`);
      setVerify([{ name: "Surface presentation", ok: false, note: message }]);
    },
    superseded() {
      supersededLayouts++;
    },
  });
  let layoutEpoch = 0;
  /* 성능 기록의 배치 번호. 기록이 켜져 있으면 배치마다 대기, 준비 응답, DOM 그리기 전후, animation frame, 표시의
     시각(performance.now, ms)을 남겨 배치가 화면에 늦게 나오는 단계를 가린다. */
  let layoutTraceId = 0;

  return {
    /** 마지막으로 실패한 배치의 오류. 그 뒤의 렌더가 표시되면 clearFailure 가 거둔다. */
    failure: () => failure,
    clearFailure() {
      failure = null;
    },
    /** 대신된 배치의 수를 한 줄로 남기고 센 수를 비운다. */
    reportSuperseded() {
      if (supersededLayouts === 0) return;
      log(`layout: ${supersededLayouts} waiting layouts were replaced by newer layouts before presentation`);
      supersededLayouts = 0;
    },
    /** 프로젝트 전환이 불러온 배치의 표시를 기다린다(projects.js 의 onSwitch). */
    async presented() {
      // 불러온 배치가 실패하면 대기열의 failed 가 그 실패를 보였다. 표시되지 않은 배치의 표시는 기다리지 않는다.
      if (!(await layouts.wait())) return;
      // `draw()`는 onRender 커밋이 끝나기 전에 반환한다. 최신 네이티브 배치가
      // 대기 중이면 프로젝트 명령은 완료되지 않은 상태다.
      await rendered();
      await surfaces.waitPresented();
    },
    /** 프로젝트 전환이 판을 비운다(projects.js 의 onSwitch). */
    async empty() {
      // 전환은 그 전에 준비한 판의 그리기를 취소한다. 그 그리기가 새 프레임 배율을 쓰는 그리기였을 수 있으므로, 판을 지우는
      // 그리기가 지금 배율을 쓰고 그 첫 행을 준비에 담는다(docs/spec/native-surfaces.md#title-bar-height).
      const epoch = ++layoutEpoch;
      const layout = frameLayout({
        factor: textSize(), publishAhead: compositor.publishAhead, publish: compositor.publish,
        frame: animationFrame, clearPlane: plane.clear,
      });
      layouts.run(() => drawPrepared({ epoch, current: () => layoutEpoch, ...layout }));
      // 판을 비운 배치가 실패하면 대기열의 failed 가 그 실패를 보였다.
      await layouts.wait();
    },
    /** 판이 만든 배치를 예약한다(plane.js 의 onLayout 수신자). */
    onLayout(made, draw, seated, titlebar) {
      const epoch = layoutEpoch;
      const id = ++layoutTraceId;
      const mark = (phase) => trace("layout", { phase, id, t: performance.now() });
      mark("queued");
      layouts.run(() => drawPrepared({
        epoch, current: () => layoutEpoch,
        prepare: async () => {
          mark("prepare");
          const result = await compositor.publishAhead(made, seated, titlebar);
          mark("prepared");
          return result;
        },
        draw: () => { mark("draw"); draw(); mark("drawn"); },
        frame: async () => { await animationFrame(); mark("frame"); },
        presented: async () => { await rendered(); mark("presented"); },
      }));
    },
    /**
     * 첫 행을 준비한 배치로 그린다. 판이 있으면 판을 다시 그리고, 판이 없는 창(라이브러리)은 표면 없이 첫 행의 높이를 담은
     * 준비 뒤에 지금 설정의 프레임 배율을 쓴다. 준비가 창 제목줄을 같은 트랜잭션에서 정하므로 행과 단추가 같은 프레임에
     * 바뀐다(docs/spec/native-surfaces.md#title-bar-height).
     */
    drawFrame() {
      if (plane.currentGrid()) {
        plane.settle();
        return;
      }
      const epoch = layoutEpoch;
      const layout = frameLayout({
        factor: textSize(), publishAhead: compositor.publishAhead, publish: compositor.publish, frame: animationFrame,
      });
      layouts.run(() => drawPrepared({ epoch, current: () => layoutEpoch, ...layout }));
    },
    /**
     * 판의 그리기 순서. 배치를 바꾼 코어 명령은 이것을 기다린 뒤 답한다. 슬롯은 가장 새 배치를 그린 뒤에 읽으므로, 이 명령이나
     * 뒤의 명령이 해제한 표면의 슬롯은 남아 있지 않다(docs/spec/exposure.md#registration).
     */
    async drawn() {
      // 가장 새 배치가 실패하면 대기열의 failed 가 그 실패를 보였다. 표시되지 않은 배치의 슬롯은 기다리지 않는다.
      if (!(await layouts.wait())) return;
      const ids = [...document.querySelectorAll("[data-native-surface-id]")]
        .map((slot) => slot.dataset.nativeSurfaceId);
      await Promise.all(ids.map((id) => waitSurfaceCompositionDeclared(id)));
    },
  };
}
