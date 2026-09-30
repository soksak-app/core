import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createLayoutQueue } from "../layout-queue.js";

// 실제 문서가 등록하는 배치 핸들러를 실행한다. 추출 문자열은 검사 결과의 판정 기준이 아니다.
const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = page.indexOf("onLayout((made, draw, seated) => {");
assert.ok(start >= 0, "the page must register its layout handler");
const end = page.indexOf("\n});", start);
assert.ok(end >= 0, "the registered layout handler must be complete");
const handler = page.slice(start, end + "\n});".length);

function fixture() {
  const calls = [];
  const errors = [];
  const frames = [];
  const prepared = Promise.withResolvers();
  const presented = Promise.withResolvers();
  const drawn = Promise.withResolvers();
  let layout;
  const context = {
    layoutEpoch: 0, drawing: Promise.resolve(), presented: presented.promise,
    layouts: createLayoutQueue({ failed: error => errors.push(error), superseded: assert.fail }),
    onLayout: callback => { layout = callback; },
    publishAhead: () => { calls.push("prepare"); return prepared.promise; },
    requestAnimationFrame: callback => frames.push(callback),
  };
  runInNewContext(handler, context, { filename: "index.html:onLayout" });
  const run = () => { layout(new Map(), () => { calls.push("draw"); drawn.resolve(); }, new Map()); return context.drawing; };
  const frame = () => { for (const callback of frames.splice(0)) callback(); };
  return { calls, errors, prepared, presented, drawn, context, run, frame };
}

test("the document waits for native preparation before drawing and retains the presentation barrier", { timeout: 1000 }, async () => {
  const f = fixture();
  const done = f.run();
  await Promise.resolve();
  assert.deepEqual(f.calls, ["prepare"], "the document drew before native preparation answered");
  f.prepared.resolve([]);
  await f.drawn.promise;
  assert.deepEqual(f.calls, ["prepare", "draw"]);
  let completed = false;
  done.then(() => { completed = true; });
  f.frame(); await Promise.resolve();
  assert.equal(completed, false, "the layout queue released before matching presentation");
  f.presented.resolve(); await done;
  assert.equal(completed, true);
  assert.deepEqual(f.errors, []);
});

test("a rejected native preparation reports failure without drawing the document", async () => {
  const f = fixture();
  const done = f.run();
  const failure = new Error("injected native preparation rejection");
  const rejected = assert.rejects(done, error => error === failure);
  await Promise.resolve();
  f.frame();
  f.prepared.reject(failure);
  await rejected;
  assert.deepEqual(f.calls, ["prepare"], "a rejected preparation changed the document");
  assert.deepEqual(f.errors, [failure]);
});

test("a changed layout epoch cancels an old draw after pending native preparation", async () => {
  const f = fixture();
  const done = f.run();
  await Promise.resolve();
  f.context.layoutEpoch++;
  f.prepared.resolve([]);
  f.frame(); f.presented.resolve();
  await done;
  assert.deepEqual(f.calls, ["prepare"], "an old preparation drew into the replacement layout");
  assert.deepEqual(f.errors, []);
});
