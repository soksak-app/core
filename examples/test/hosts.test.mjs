// 두 애플리케이션이 같은 페이지에 같은 답을 주는지 검사한다.
//
// 페이지는 하나이고 호스트는 둘이다. 같은 입력에 대해 두 호스트의 답이 다르면 그것이
// 곧 차이다. 기록기는 페이지 안에 있으므로 두 애플리케이션이 같은 형식으로 남기고,
// 이 검사는 그 두 기록을 대조한다.
//
// 애플리케이션이 빌드되어 있지 않으면 건너뛴다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, ask } from "./app.mjs";

/** 대조에 쓰는 끌기. 경계를 이름으로 지정하므로 창의 크기에 의존하지 않는다. */
const DRIVE = "4000,x,2,-120,0,48,2";

/** 모달을 열고 그 안의 구획을 바꾼다. 모달의 호출도 대조 대상에 든다. */
const CLICK = '4500,button.act[title="설정"];.set-nav[data-key="nav:compositing"]';

/** 기록 한 줄. 호출 이름과 요청과 답이다. */
const LINE = /host (\w+) (\{.*\}|\[.*\]|null) -> (.*)$/;

/**
 * 한 실행의 기록을 { 호출 이름 → [ {요청, 답} ] } 로 읽는다.
 *
 * id 는 실행마다 새로 발급되므로 그대로 두면 두 기록이 언제나 다르다. 처음 나온
 * 순서대로 번호를 붙여 같은 자리의 id 가 같은 이름을 갖게 한다.
 */
function transcript(log) {
  const names = new Map();
  const same = (text) =>
    text.replace(/(prj|spc|tab)-[a-z0-9]+/g, (id, kind) => {
      if (!names.has(id)) names.set(id, `${kind}-${names.size}`);
      return names.get(id);
    });
  const calls = new Map();
  for (const line of log.split("\n")) {
    const found = LINE.exec(line);
    if (!found) continue;
    const [, name, request, answer] = found;
    if (!calls.has(name)) calls.set(name, []);
    calls.get(name).push({ request: same(request), answer: same(answer) });
  }
  return calls;
}

/** 갱신이 끝난 뒤의 마지막 요청. 그 상태는 두 실행에서 같다. */
const atRest = (calls) =>
  [...(calls.get("syncSurfaces") ?? [])].reverse().find((c) => /"settled":true/.test(c.request));

/**
 * 두 번째 크기. 시작 크기에서만 대조하면 두 호스트가 어긋날 수 있는 자리를 검사하지
 * 않는다 — 라운드 7 의 결함은 창의 크기가 바뀐 뒤에만 드러났다.
 *
 * 크기는 이 검사가 지정한다. 최대화가 주는 크기는 화면의 가용 영역이고, 그 영역은
 * 애플리케이션이 시작한 직후에 1pt 바뀐다. 두 애플리케이션이 그 변화의 양쪽에서
 * 최대화하면 창의 크기가 서로 달라지고, 그 차이는 이 검사가 재려는 것이 아니다.
 * 크기를 지정하면 그 경주가 결과를 움직이지 못한다.
 */
const SIZE = { w: 1000, h: 620 };

/** 창이 그 크기를 실제로 가졌다고 보고한 줄. 창이 알린다. */
const SIZED = `observe: sized ${SIZE.w}x${SIZE.h}`;

/** 그 보고 이후의 기록. 크기가 바뀌기 전의 커밋은 대조 대상이 아니다. */
const afterResize = (log = "") => {
  const at = log.lastIndexOf(SIZED);
  return at < 0 ? null : log.slice(at);
};

test("both hosts answer the same page the same way", async (t) => {
  const logs = {};
  for (const [name, binary] of Object.entries(APPS)) {
    logs[name] = await ask(
      binary,
      ["transcript on", `drag ${DRIVE} `, `click ${CLICK}`],
      (text) =>
        /observe: shaking done/.test(text) &&
        /"settled":true/.test(text) &&
        /host overlayPlace/.test(text),
      { timeout: 40_000 },
    );
    if (!logs[name]) return t.skip(`${binary} is not built`);
  }

  const wails = transcript(logs.wailsv3);
  const tauri = transcript(logs.tauriv2);

  const restedWails = atRest(wails);
  const restedTauri = atRest(tauri);
  assert.ok(restedWails, `the Wails host recorded no settled commit:\n${logs.wailsv3}`);
  assert.ok(restedTauri, `the Tauri host recorded no settled commit:\n${logs.tauriv2}`);

  // 페이지가 보내는 요청이 다르면 호스트가 페이지에게 준 것이 다르다는 뜻이다.
  assert.equal(
    restedTauri.request, restedWails.request,
    "the two hosts give the page a different plane to lay out",
  );
  // 답이 다르면 호스트가 같은 요청을 다르게 처리한다는 뜻이다.
  assert.equal(
    restedTauri.answer, restedWails.answer,
    "the two hosts place the same surfaces differently",
  );

  // 한쪽에만 있는 호출은 한쪽만 구현했거나 한쪽만 답한다는 뜻이다.
  assert.deepEqual(
    [...tauri.keys()].sort(), [...wails.keys()].sort(),
    "the two hosts were asked for different things",
  );

  // 나머지 호출도 마지막 것끼리 대조한다. 모달을 열고 그 구획을 바꾼 뒤의 상태는
  // 두 실행에서 같다.
  for (const name of wails.keys()) {
    if (name === "syncSurfaces") continue;
    const mine = wails.get(name).at(-1);
    const theirs = tauri.get(name).at(-1);
    assert.equal(theirs.request, mine.request, `${name} was asked differently`);
    assert.equal(theirs.answer, mine.answer, `${name} was answered differently`);
  }
});

test("both hosts lay out the same page the same way after a resize", async (t) => {
  const rested = {};
  for (const [name, binary] of Object.entries(APPS)) {
    const log = await ask(
      binary,
      ["transcript on", `size ${SIZE.w},${SIZE.h}`],
      // 창이 지정된 크기를 가졌다고 보고한 뒤의 커밋을 기다린다. 그 크기에 이르지
      // 못하는 호스트는 여기서 예산이 끝나고, 그 로그가 실패에 실린다.
      (text) => /"settled":true/.test(afterResize(text) ?? ""),
      { timeout: 30_000 },
    );
    if (!log) return t.skip(`${binary} is not built`);
    const found = atRest(transcript(afterResize(log)));
    assert.ok(found, `${name} recorded no settled commit after the resize:\n${log}`);
    rested[name] = found;
  }

  // 두 창이 같은 크기이므로, 요청이 다르면 그것은 크기의 차이가 아니라 배치의 차이다.
  assert.equal(
    rested.tauriv2.request, rested.wailsv3.request,
    `the two hosts give the page a different plane at ${SIZE.w}x${SIZE.h}`,
  );
  assert.equal(
    rested.tauriv2.answer, rested.wailsv3.answer,
    `the two hosts place the same surfaces differently at ${SIZE.w}x${SIZE.h}`,
  );
});
