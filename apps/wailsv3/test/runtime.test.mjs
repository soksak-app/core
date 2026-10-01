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

test("a page sidecar failure reaches only the listener of that sidecar and surface", async () => {
  const listeners = [];
  globalThis.window = { __soksakNative: {
    call: async () => null,
    on: (event, fn) => { listeners.push([event, fn]); return () => {}; },
  } };
  globalThis.location = { search: "?id=s1" };
  try {
    // 이 검사만 별도의 모듈 사본을 쓴다 — 런타임은 첫 불러오기에 window 를 붙잡는다.
    const { page } = await import("../runtime/index.js?test=sidecar-failure");
    const reasons = [];
    const off = await page.sidecar("@x/side").onFailure("s1", (reason) => reasons.push(reason));
    assert.equal(typeof off, "function");
    const [event, deliver] = listeners.at(-1);
    assert.equal(event, "sidecar-failure");
    deliver({ sidecar: "@x/side", surface: "s2", reason: "another surface" });
    deliver({ sidecar: "@x/other", surface: "s1", reason: "another sidecar" });
    deliver({ sidecar: "@x/side", surface: "s1", reason: "output closed: exit status 3" });
    assert.deepEqual(reasons, ["output closed: exit status 3"]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});
