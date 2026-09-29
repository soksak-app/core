import assert from "node:assert/strict";
import test from "node:test";

test("surface readiness invokes the registered native presentation method", async () => {
  const calls = [];
  globalThis.window = {
    __soksakNative: {
      call: async (method, args) => {
        calls.push([method, args]);
        return 42;
      },
      on: async () => () => {},
    },
  };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js");
    assert.equal(await host.call("waitPresented"), 42);
    assert.deepEqual(calls, [["WaitPresented", []]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("the performance trace command carries the page request to the host", async () => {
  const calls = [];
  globalThis.window = { __soksakNative: { call: async (method, args) => { calls.push([method, args]); return null; }, on: () => () => {} } };
  globalThis.location = { search: "?id=tab" };
  try {
    // 이 검사만 별도의 모듈 사본을 쓴다 — 런타임은 첫 불러오기에 window 를 붙잡는다.
    const { host } = await import("../runtime/index.js?test=performance-command");
    await host.call("performance", { action: "line", line: { event: "action" } });
    assert.deepEqual(calls, [["Performance", [{ action: "line", line: { event: "action" } }]]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});
