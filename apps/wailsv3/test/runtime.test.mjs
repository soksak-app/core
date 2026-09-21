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
