// 터미널 표면의 입력이 셸 사이드카를 거쳐 같은 표면의 출력으로 돌아오는지 검사한다.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";

import { APPS, nativeProbe } from "./app.mjs";

// 터미널 페이지에서 한 줄을 입력하고, 출력에 기대한 줄이 나타날 때까지 기다린 뒤 출력 줄을 반환한다.
// 기다림은 출력 요소의 변경 이벤트로 판정하고, 10초 안에 나타나지 않으면 실패한다.
const typeLine = (line, expected) => `
  const out = document.getElementById("out");
  const input = document.getElementById("in");
  const lines = () => out.textContent.split("\\n");
  const seen = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { observer.disconnect(); reject(new Error("no output: " + out.textContent)); }, 10000);
    const observer = new MutationObserver(() => {
      if (!lines().includes(${JSON.stringify(expected)})) return;
      clearTimeout(deadline);
      observer.disconnect();
      resolve(lines());
    });
    observer.observe(out, { childList: true, characterData: true, subtree: true });
  });
  input.value = ${JSON.stringify(line)};
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return await seen;
`;

for (const [name, binary] of Object.entries(APPS)) {
  test(`${name}: terminal input returns shell output through the shell sidecar`, async (t) => {
    const state = await nativeProbe(binary, { op: "state" }, true);
    if (!state) return t.skip(`${binary} is not built`);
    const root = await nativeProbe(binary, { op: "evalAsync", match: "main",
      script: 'return (await import("/projects.js")).active().root;' });
    const terminals = state.views.filter((view) => view.url.includes("terminal.html"));
    assert.ok(terminals.length >= 2, `expected two terminal surfaces: ${JSON.stringify(state.views)}`);
    const [shown] = terminals.filter((view) => !view.hidden);

    const marker = `sidecar-${process.pid}-${Date.now()}`;
    const echoed = await nativeProbe(binary, { op: "evalAsync", match: shown.url, script: typeLine(`echo ${marker}`, marker) });
    assert.equal(echoed.filter((line) => line === marker).length, 1, "the shell output appears once");
    const directory = await nativeProbe(binary, { op: "evalAsync", match: shown.url,
      script: typeLine("pwd", realpathSync(root)) });
    assert.ok(directory.includes(realpathSync(root)), "the shell runs in the project directory");

    // 다른 터미널 표면은 이 표면의 출력을 받지 않는다.
    const other = terminals.find((view) => view.url !== shown.url);
    const otherText = await nativeProbe(binary, { op: "eval", match: other.url,
      script: 'document.getElementById("out").textContent' });
    assert.ok(!otherText.includes(marker), "another surface received this surface's output");
  });
}
