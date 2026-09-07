// 두 호스트의 최종 요청과 표시 좌표를 비교한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, ask } from "./app.mjs";

const DRIVE = "4000,x,2,-120,0,48,2";

const CLICK = 'button.act[title="설정"];.set-nav[data-key="nav:compositing"]';

const LINE = /host (\w+) (\{.*\}|\[.*\]|null) -> (.*)$/;

function transcript(log) {
  const names = new Map();
  const same = (text) =>
    text.replace(/"ticket":\d+,/g, "").replace(/(prj|spc|tab)-[a-z0-9]+/g, (id, kind) => {
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

const atRest = (calls) => {
  const prepared = [...(calls.get("syncSurfaces") ?? [])].reverse().find((c) => /"settled":true/.test(c.request));
  const presented = [...(calls.get("presentSurfaces") ?? [])].reverse().find((c) => /"settled":true/.test(c.request));
  return prepared && presented && { request: prepared.request, answer: presented.answer };
};

const presented = (text) => /host presentSurfaces .*"settled":true.* ->/.test(text);

const SIZE = { w: 1000, h: 620 };

const SIZED = `observe: sized ${SIZE.w}x${SIZE.h}`;

const afterResize = (log = "") => {
  const at = log.lastIndexOf(SIZED);
  return at < 0 ? null : log.slice(at);
};

test("both hosts answer the same page the same way", async (t) => {
  const logs = {};
  for (const [name, binary] of Object.entries(APPS)) {
    const dragged = await ask(
      binary,
      ["transcript on", `drag ${DRIVE} `],
      (text) => /observe: shaking done/.test(text) && presented(text),
      { timeout: 20_000 },
    );
    if (!dragged) return t.skip(`${binary} is not built`);
    const clicked = await ask(binary, `click ${CLICK}`,
      (text) => /host overlayPlace/.test(text),
      { timeout: 20_000, from: false });
    logs[name] = dragged + clicked;
  }

  const wails = transcript(logs.wailsv3);
  const tauri = transcript(logs.tauriv2);

  const restedWails = atRest(wails);
  const restedTauri = atRest(tauri);
  assert.ok(restedWails, `the Wails host recorded no settled commit:\n${logs.wailsv3}`);
  assert.ok(restedTauri, `the Tauri host recorded no settled commit:\n${logs.tauriv2}`);
  assert.equal(
    restedTauri.request, restedWails.request,
    "the two hosts give the page a different plane to lay out",
  );
  assert.equal(
    restedTauri.answer, restedWails.answer,
    "the two hosts place the same surfaces differently",
  );
  assert.deepEqual(
    [...tauri.keys()].sort(), [...wails.keys()].sort(),
    "the two hosts were asked for different things",
  );
  for (const name of wails.keys()) {
    if (name === "syncSurfaces" || name === "presentSurfaces") continue;
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
      (text) => presented(afterResize(text) ?? ""),
      { timeout: 30_000 },
    );
    if (!log) return t.skip(`${binary} is not built`);
    const found = atRest(transcript(afterResize(log)));
    assert.ok(found, `${name} recorded no settled commit after the resize:\n${log}`);
    rested[name] = found;
  }
  assert.equal(
    rested.tauriv2.request, rested.wailsv3.request,
    `the two hosts give the page a different plane at ${SIZE.w}x${SIZE.h}`,
  );
  assert.equal(
    rested.tauriv2.answer, rested.wailsv3.answer,
    `the two hosts place the same surfaces differently at ${SIZE.w}x${SIZE.h}`,
  );
});
