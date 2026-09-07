// 열려 있는 모달의 문서가 갱신된 내용을 받는지 본다.
//
// 호스트는 모달의 창을 만들고 옮기고 크기를 바꾸고, 그 셋은 메인 페이지의 호출과 답으로
// 확인된다. 그 문서가 무엇을 그리는지는 그것으로 확인되지 않는다 — 갱신이 문서에
// 도달하지 않아도 창은 새 크기를 갖고 호출은 모두 같은 답을 받는다. 라운드 9 의 결함이
// 그것이었다: Tauri 의 모달 웹뷰가 이벤트를 하나도 받지 못했고, 그동안 이 폴더의 검사가
// 모두 통과했다.
//
// 모달의 문서는 렌더링할 때마다 준비를 보고한다. 호스트는 한 번의 표시에 한 번만 창을
// 올리고 나머지 보고는 관측 부품에 남긴다. 한 번의 표시에 그 줄이 둘이면 그 문서가
// 갱신을 받은 것이고, 하나면 받지 못한 것이다.
//
// 애플리케이션이 빌드되어 있지 않으면 건너뛴다. `make examples-verify` 가 먼저 빌드한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, ask } from "./app.mjs";

/**
 * 모달을 열고 그 안의 구획을 바꾼다. 구획을 바꾸면 페이지가 내용 갱신을 전송한다.
 *
 * 마지막 기다림은 그 갱신이 문서에 닿을 시간이다. 그 시간을 다 쓰지 않아도 두 번째
 * 렌더링이 오면 실행은 거기서 끝난다.
 */
const CLICK = 'button.act[title="설정"];2000;.set-nav[data-key="nav:compositing"];3000';

/** 갱신이 도달할 시간을 다 쓴 지점. 도달하지 않은 실행은 여기서 끝난다. */
const WAITED = "observe: waited 3000ms";

/** 이 모달의 문서가 렌더링을 보고한 횟수. 관측 부품이 한 줄씩 남긴다. */
const renders = (log, id) =>
  log.split("\n").filter((line) => line.endsWith(`observe: modal rendered ${id}`)).length;

for (const [name, binary] of Object.entries(APPS)) {
  test(`${name}: an open modal's document receives the content the page updates`, async (t) => {
    const log = await ask(
      binary,
      `click ${CLICK}`,
      (text) => renders(text, "settings") >= 2 || text.includes(WAITED),
      { timeout: 30_000 },
    );
    if (!log) return t.skip(`${binary} is not built`);
    assert.ok(
      renders(log, "settings") >= 2,
      `${name}: the settings modal's document rendered once and never again, so the ` +
        `update the page sent never reached it:\n${log}`,
    );
  });
}
