// 페이지 쪽 관측.
//
// 호스트의 관측 부품이 요청하면 이 문서에서 그 일을 한다. 요청은 둘이다. CSS 선택자로
// 지정한 요소를 누르는 것과, 이름으로 지정한 경계를 끄는 것이다.
//
// 두 애플리케이션이 이 파일을 함께 실행하므로, 무엇을 누르고 어떻게 끄는지는 한 번만
// 적힌다. 호스트가 각자 구현하면 그 둘이 어긋날 수 있다.
//
// 호스트가 요청하지 않으면 실행되지 않는다.
import { host } from "./framework/index.js";
import { surfaceInput } from "./plane.js";

if (host) {
  // 선택자 여럿을 `;` 으로 이어 보내면 순서대로 누른다. 하나의 창을 열고 그 안의
  // 것을 누르는 것이 한 번의 요청이어야 하기 때문이다.
  host.on("observe-click", (selectors) => {
    for (const selector of selectors.split(";")) {
      const el = document.querySelector(selector);
      if (!el) {
        host.call("report", `observe: ${selector} not found`);
        continue;
      }
      el.click();
      host.call("report", `observe: clicked ${selector}`);
    }
  });

  host.on("observe-drag", (plan) => shake(plan));
}

/** 한 걸음의 길이. 화면이 갱신되는 간격이다. */
const FRAME = 16;

/**
 * 이름으로 지정한 경계를 흔든다.
 *
 * 좌표가 아니라 축과 선 번호로 지정한다. 좌표로 지정하면 창의 크기가 달라질 때마다
 * 그 값을 다시 정해야 하고, 빗나가도 아무 일도 일어나지 않는다.
 *
 * 각 걸음은 표면 위의 누름과 같은 경로로 전달된다. 끌기는 시간에 따른 움직임이므로
 * 걸음을 시계로 만든다. 이 시계는 무엇을 확인하지 않는다.
 */
async function shake({ axis, line, dx, dy, ms, times }) {
  const divider = document.querySelector(
    `.sp-divider[data-axis="${axis}"][data-line="${line}"]`);
  if (!divider) {
    host.call("report", `observe: no ${axis} boundary at line ${line}`);
    return;
  }
  const box = divider.getBoundingClientRect();
  const from = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const steps = Math.max(1, Math.round(ms / FRAME));
  host.call("report",
    `observe: shaking ${axis}:${line} at (${Math.round(from.x)},${Math.round(from.y)}) ` +
    `by ${dx},${dy} in ${steps} steps, ${times} times`);

  // 한 번 누른 채로 왕복한다. 놓았다 다시 누르면, 경계가 최소 카드 크기에서 멈춰
  // 지정한 만큼 이동하지 못했을 때 다음 누름이 빗나간다.
  surfaceInput({ phase: 0, x: from.x, y: from.y });
  for (let turn = 0; turn < times; turn++) {
    await sweep(from, dx, dy, 0, 1, steps);
    await sweep(from, dx, dy, 1, 0, steps);
  }
  surfaceInput({ phase: 2, x: from.x, y: from.y });
  host.call("report", "observe: shaking done");
}

/** 누른 지점을 오프셋의 한 비율에서 다른 비율까지 옮긴다. */
async function sweep(from, dx, dy, start, end, steps) {
  for (let i = 1; i <= steps; i++) {
    await new Promise((go) => setTimeout(go, FRAME));
    const at = start + (end - start) * (i / steps);
    surfaceInput({ phase: 1, x: from.x + dx * at, y: from.y + dy * at });
  }
}
