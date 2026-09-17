// 창 단추가 첫 행의 가운데에 있는지, 최대화·녹화·이동·크기 변경·제목 변경 뒤에도 그 자리인지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, drag, fresh, open } from "./app.mjs";

const PLAN = { axis: "x", line: 2, dx: -250, dy: 0, ms: 48, times: 3 };

/** 창 변경을 반복하는 횟수. */
const ROUNDS = 6;

/** 창 버튼 세 개가 보이고 창 머리 행의 가운데에 있는지 확인한다. */
async function centred(s, when) {
  const state = await s.get("host.window");
  const bar = await s.rect("core.chrome.bar");
  assert.equal(state.controls.length, 3);
  for (const button of state.controls) {
    assert.equal(button.hidden, false, `a native button is hidden ${when}`);
    const offset = button.y + button.height / 2 - (bar.y + bar.height / 2);
    assert.ok(Math.abs(offset) <= 0.25,
      `native button is ${offset}pt from the row centre ${when}: ${JSON.stringify(button)}, row ${JSON.stringify(bar)}`);
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising the window leaves its own buttons in place`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const before = (await s.get("host.window")).frame;
    await s.run("host.window.maximize", { on: true });
    try {
      await s.until("host.window", (w) => w.frame.width !== before.width || w.frame.height !== before.height,
        "the window did not maximise");
      await s.presented();
      await centred(s, "after maximising");
    } finally {
      await s.run("host.window.maximize", { on: false });
      await s.until("host.window", (w) => w.frame.width === before.width && w.frame.height === before.height,
        "the window did not return to its size");
      await s.presented();
    }
  });

  test(`${app.name}: stopping a window recording leaves the native buttons centred`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await drag(t, s, PLAN, { capture: true });
    // 창 제목이나 녹화 표시가 바뀌면 AppKit 이 단추를 되가져가고, 라이브러리가 다음 실행 루프
    // 차례 전에 다시 둔다. 같은 차례에 처리되는 요청은 그 사이의 위치를 읽을 수 있으므로 다음
    // 표시 이후의 위치를 잰다.
    await s.presented();
    await centred(s, "after recording");
  });

  test(`${app.name}: moving, resizing, and renaming keep the buttons centred in the first row`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const start = (await s.get("host.window")).frame;
    const project = await s.get("core.project");
    // 창이 있는 화면의 사용 가능 영역이 최대화한 창의 크기다. 창이 그 크기에 도달한 뒤 다음
    // 조작을 한다. 확대가 진행 중일 때 복원을 요청하면 창이 최대화 상태로 남는다.
    const screen = (await s.get("host.screens")).find((x) => start.x >= x.x && start.x < x.x + x.width
      && start.y >= x.y && start.y < x.y + x.height);
    try {
      for (let round = 0; round < ROUNDS; round++) {
        await s.run("host.window.move", { x: start.x + 40, y: start.y + 30 });
        await centred(s, "after moving the window");
        await s.run("host.window.move", { x: start.x, y: start.y });
        await s.run("host.window.resize", { width: start.width - 100, height: start.height - 60 });
        await centred(s, "after resizing the window");
        await s.run("host.window.resize", { width: start.width, height: start.height });
        await s.run("host.window.maximize", { on: true });
        await s.until("host.window", (w) => w.maximized && w.frame.width === screen.visible.width
          && w.frame.height === screen.visible.height, "the window did not maximise");
        await centred(s, "while the window is maximised");
        await s.run("host.window.maximize", { on: false });
        await s.until("host.window", (w) => !w.maximized && w.frame.width === start.width,
          "the window did not return to its size");
        // 제목이 바뀌면 AppKit 이 제목줄을 다시 배치한다.
        await s.run("core.project.rename", { id: project.id, title: `${project.title}` });
        await centred(s, "after a title change");
      }
    } finally {
      await s.run("host.window.maximize", { on: false });
      await s.run("host.window.resize", { width: start.width, height: start.height });
      await s.run("host.window.move", { x: start.x, y: start.y });
    }
    t.diagnostic(`the buttons stayed centred through ${ROUNDS} rounds of window changes`);
  });
}
