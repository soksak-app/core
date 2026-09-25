// 페이지 쪽 진단 메서드.
//
// 진단 빌드의 호스트가 exposure-request 로 요청하면 이 문서에서 그 일을 한다. 메서드는
// 셋이다. 설정과 프로젝트를 검사 전 상태로 되돌리는 diagnostics.fixture, 이름으로
// 지정한 경계를 호스트의 시각에 맞춰 끄는 diagnostics.drag, 호출 기록을 켜고 끄는
// diagnostics.transcript 다. 끌기의 걸음은
// 호스트 이벤트 diagnostics-tick 으로 온다.
//
// 두 애플리케이션이 이 파일을 함께 실행하므로, 어떻게 끄는지는 한 번만 적힌다.
// 호스트가 요청하지 않으면 실행되지 않는다.
import { registry } from "./exposure.js";
import { native, report, watchCalls } from "./host.js";
import { createTranscript } from "./transcript.js";
import { host } from "@soksak/runtime";
import { currentGrid, surfaceInput } from "./plane.js";

registry.method("diagnostics.fixture", async ({ root, settings: overrides }) => {
  if (typeof root !== "string" || !root) throw new Error("diagnostics.fixture requires root");
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    throw new Error("diagnostics.fixture settings must be an object");
  }
  const projects = await import("./projects.js");
  const settings = await import("./settings.js");
  const plane = await import("./plane.js");
  await projects.flush();
  for (const project of [...projects.all()]) await projects.close(project.id);
  // 검사가 준 공통 설정은 기본값과 한 번에 적용한다. 열리는 표면이 그 값으로 시작하고 변경 알림은 한 번이다.
  await settings.set({ ...structuredClone(settings.defaults), ...overrides }, "common");
  await projects.open({ root, color: "#ffb36b", layout: plane.fresh() });
  await projects.flush();
  return { root };
});

// 호출 기록기. 기록기가 이 패키지에 있으므로 두 애플리케이션이 같은 형식과 순서로 남긴다.
const transcript = createTranscript(report);
if (native) watchCalls((name, payload, answered) => transcript.record(name, payload, answered));

registry.method("diagnostics.transcript", ({ on }) => {
  transcript.set(on === true);
  return null;
});

registry.method("diagnostics.drag", (plan) => shake(plan));

host?.on("diagnostics-tick", () => {
  if (waiting) {
    const go = waiting;
    waiting = null;
    go();
  } else {
    pending++;
  }
});

/**
 * 걸음의 시각은 호스트가 준다.
 *
 * 창이 앞에 없으면 브라우저는 이 문서를 숨은 것으로 보고 setTimeout 을 1초 가까이로
 * 묶는다. 16ms 를 요청한 걸음이 그만큼 늘어나면 끌기는 사람이 끄는 속도가 아니게 되고,
 * 그 속도에서만 드러나는 결함은 드러나지 않는다. 호스트의 시계는 창이 어디에 있든
 * 늦춰지지 않으므로, 끌기가 무엇인지는 여기에 적히고 걸음이 언제인지는 호스트가
 * diagnostics-tick 이벤트로 준다.
 *
 * 도착한 걸음은 세어 둔다. 이 문서가 한 걸음을 처리하는 동안 다음 걸음이 오면, 그것을
 * 기다리는 쪽이 아직 없기 때문이다.
 */
let pending = 0;
let waiting = null;

/* 이 문서가 기다리기 전에 도착한 걸음의 수와, 그렇게 밀린 걸음의 수. 둘 다 0 이면
   이 문서가 호스트의 걸음을 제때 따라간 것이고, 끌기는 요청한 모양 그대로다. */
let deepest = 0;
let late = 0;

const tick = () => {
  if (pending > 0) {
    deepest = Math.max(deepest, pending);
    late++;
    pending--;
    return Promise.resolve();
  }
  return new Promise((go) => {
    waiting = go;
  });
};

/** 한 걸음의 길이. 화면이 갱신되는 간격이다. 호스트가 같은 값으로 걸음을 보낸다. */
const FRAME = 16;

/**
 * 이름으로 지정한 경계를 흔들고, 끝나면 걸린 시간과 늦은 걸음을 반환한다.
 *
 * 좌표가 아니라 축과 선 번호로 지정한다. 좌표로 지정하면 창의 크기가 달라질 때마다
 * 그 값을 다시 정해야 하고, 빗나가도 아무 일도 일어나지 않는다.
 *
 * 각 걸음은 표면 위의 누름과 같은 경로로 전달된다. 호스트는 steps × 2 × times 개의
 * diagnostics-tick 이벤트를 FRAME 간격으로 보낸다.
 */
async function shake({ axis, line, dx, dy, ms, times }) {
  const divider = document.querySelector(
    `.sp-divider[data-axis="${axis}"][data-line="${line}"]`);
  if (!divider) throw new Error(`no ${axis} boundary at line ${line}`);
  const box = divider.getBoundingClientRect();
  const from = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const steps = Math.max(1, Math.round(ms / FRAME));

  // 한 번 누른 채로 왕복한다. 놓았다 다시 누르면, 경계가 최소 카드 크기에서 멈춰
  // 지정한 만큼 이동하지 못했을 때 다음 누름이 빗나간다.
  // 앞선 끌기가 받아 두고 쓰지 않은 걸음은 이 끌기의 것이 아니다. 남겨 두면 이
  // 끌기가 그만큼을 한 번에 소비해 요청보다 빨리 끝난다.
  pending = 0;
  waiting = null;
  late = 0;
  deepest = 0;
  surfaceInput({ phase: 0, x: from.x, y: from.y });
  // 걸음마다 격자에 놓인 경계의 위치. 경계는 이웃 선에 붙거나 최소 크기에서 멈추므로
  // 포인터 위치와 같지 않다. 녹화한 화면이 어느 걸음의 배치인지는 이 값으로 찾는다.
  const boundary = [currentGrid().boundaryPos(axis, line)];
  // 걸음마다 이 문서가 입력을 적용하고 배치를 계산한 시간(ms). 초반 걸음이 느린지 본다.
  const handled = [];
  const began = performance.now();
  for (let turn = 0; turn < times; turn++) {
    await sweep(from, dx, dy, 0, 1, steps, () => boundary.push(currentGrid().boundaryPos(axis, line)), handled);
    await sweep(from, dx, dy, 1, 0, steps, () => boundary.push(currentGrid().boundaryPos(axis, line)), handled);
  }
  const took = performance.now() - began;
  surfaceInput({ phase: 2, x: from.x, y: from.y });
  // 이 시계는 페이지의 것이다. 창이 앞에 없으면 브라우저가 그것을 늦추므로, 걸린
  // 시간을 함께 반환한다.
  return {
    from, steps: times * 2 * steps, took: Math.round(took), asked: times * 2 * steps * FRAME,
    late, deepest, boundary, handled,
  };
}

/** 누른 지점을 오프셋의 한 비율에서 다른 비율까지 옮기고, 걸음마다 moved 를 부른다. */
async function sweep(from, dx, dy, start, end, steps, moved, handled) {
  for (let i = 1; i <= steps; i++) {
    await tick();
    const at = start + (end - start) * (i / steps);
    const began = performance.now();
    surfaceInput({ phase: 1, x: from.x + dx * at, y: from.y + dy * at });
    moved();
    handled.push(Math.round((performance.now() - began) * 10) / 10);
  }
}
