// 사이드카 전송이 호출한 순서대로 호스트에 전달되는지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { orderedSidecar } from "@soksak/plugin-api";

/** 전송을 기록하고, 전송마다 정한 시간 뒤에 끝나는 포트. 호출이 겹치면 늦게 시작한 전송이 먼저 끝날 수 있다. */
function slowPort(delays) {
  const started = [];
  const finished = [];
  let active = 0;
  let overlapped = false;
  return {
    started, finished, overlapped: () => overlapped,
    send(surface, body) {
      started.push(body.n);
      if (++active > 1) overlapped = true;
      return new Promise((resolve) => setTimeout(() => {
        active--;
        finished.push(body.n);
        resolve();
      }, delays[body.n]));
    },
    on: (surface, fn) => ({ surface, fn }),
  };
}

test("sends reach the host in call order", async () => {
  const port = slowPort({ 1: 30, 2: 1, 3: 10 });
  const sidecar = orderedSidecar(port, () => {});
  await Promise.all([1, 2, 3].map((n) => sidecar.send("tab", { n })));
  assert.deepEqual(port.finished, [1, 2, 3]);
  assert.equal(port.overlapped(), false);
});

test("a failed send is reported and does not stop later sends", async () => {
  const port = slowPort({ 2: 1 });
  port.send = ((send) => (surface, body) => body.n === 1 ? Promise.reject(new Error("gone")) : send(surface, body))(port.send);
  const failures = [];
  const sidecar = orderedSidecar(port, (error) => failures.push(error.message));
  const first = sidecar.send("tab", { n: 1 });
  const second = sidecar.send("tab", { n: 2 });
  await assert.rejects(first, /gone/);
  await second;
  assert.deepEqual(port.finished, [2]);
  assert.deepEqual(failures, ["gone"]);
});

test("a failed send is passed to the failure handler with its error", async () => {
  const failures = [];
  const port = slowPort({});
  port.send = () => Promise.reject(new Error("gone"));
  const sidecar = orderedSidecar(port, (error) => failures.push(error.message));
  await assert.rejects(sidecar.send("tab", { n: 1 }), /gone/);
  await sidecar.send("tab", { n: 2 }).catch(() => {});
  assert.deepEqual(failures, ["gone", "gone"]);
});

test("listening goes to the runtime port", () => {
  const port = slowPort({});
  const fn = () => {};
  assert.deepEqual(orderedSidecar(port, () => {}).on("tab", fn), { surface: "tab", fn });
});

test("failure listening goes to the runtime port", () => {
  const port = { ...slowPort({}), onFailure: (surface, fn) => ({ failure: surface, fn }) };
  const fn = () => {};
  assert.deepEqual(orderedSidecar(port).onFailure("tab", fn), { failure: "tab", fn });
});
