// core.tab.close 는 탭 닫기가 끝난 뒤에 판의 그리기를 기다린다. 탭 닫기는 표면을 해제한 뒤 탭을 판에서 빼고 새 배치를
// 예약한다. 명령이 그 닫기를 기다리지 않으면 명령의 그리기 대기는 해제 전에 슬롯을 읽고 답하며, 검사가 이어서 보낸
// 다음 명령의 대기가 해제된 표면을 아직 이름으로 가진 슬롯을 읽고 `surface … is not mounted` 로 실패한다(F50).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("core.tab.close answers after the tab close and its draw", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);

  // 탭 닫기는 검사가 끝낼 때까지 해제 중이다. 명령의 순서는 기록한다.
  const events = [];
  let finishClose;
  const actualPlane = await import("../plane.js");
  t.mock.module("../plane.js", { exports: { ...actualPlane,
    closeTabById: (tab) => {
      events.push(`close ${tab}`);
      return new Promise((resolve) => { finishClose = () => { events.push(`closed ${tab}`); resolve(); }; });
    },
  } });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  try {
    await installCoreExposure({
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null,
      drawn: async () => { events.push("settled"); },
    });
    let answered = false;
    const answer = registry.run("core.tab.close", { tab: "tab-a" }).then(() => { answered = true; });
    // 대기 중인 microtask 를 모두 실행한다. 해제가 끝나지 않은 동안 명령은 답하지 않고 그리기 대기도 시작하지 않는다.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["close tab-a"], "the command waited for the draw before the tab close finished");
    assert.equal(answered, false, "the command answered before the tab close finished");
    finishClose();
    await answer;
    assert.deepEqual(events, ["close tab-a", "closed tab-a", "settled"]);
  } finally {
    dom.window.close();
  }
});
