import assert from "node:assert/strict";
import test from "node:test";

// A document of a surface asks the host for the log policy at its load (action policy-read); the host interface below answers it with the
// default policy and does not record it.
const policyRead = { classes: { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" } };

/** The call channel that the adapter injects, with every call recorded and reply fixed. */
function channel(calls, replies = new Map()) {
  const listeners = new Map();
  let stream = null;
  return {
    __soksak: {
      call: async (command, args) => {
        calls.push([command, args]);
        if (replies.has(command)) return replies.get(command);
        return 42;
      },
      on: async (event, fn) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
        return () => listeners.get(event)?.delete(fn);
      },
      event: (name, data) => {
        for (const fn of listeners.get(name) ?? []) fn(data);
      },
      onStream: (fn) => { stream = fn; },
      stream: (text) => stream?.(JSON.parse(text)),
    },
  };
}

test("surface readiness invokes the registered native presentation command", async () => {
  const calls = [];
  globalThis.window = channel(calls);
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?test=interface");
    assert.equal(await host.call("waitPresented"), 42);
    assert.deepEqual(calls, [["wait_presented", {}]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("ordered main events register before subscribers proceed and dispatch through one stream", async () => {
  const calls = [];
  let finishRegistration;
  globalThis.window = channel(calls);
  globalThis.window.__soksak.call = (command, args) => {
    calls.push([command, args]);
    if (command === "view_source_event_stream") {
      return new Promise((resolve) => { finishRegistration = resolve; });
    }
    return Promise.resolve(null);
  };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?test=ordered-stream");
    let first = null;
    const registered = host.on("view-call", (value) => { first = value; });
    await Promise.resolve();
    assert.deepEqual(calls, [["view_source_event_stream", {}]]);
    finishRegistration(null);
    await registered;
    globalThis.window.__soksak.stream(JSON.stringify({ name: "view-call", value: { surface: "s1" } }));
    assert.deepEqual(first, { surface: "s1" });
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("a host event delivers its value to the listener alone", async () => {
  const calls = [];
  globalThis.window = channel(calls);
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?test=host-event");
    let theme = null;
    await host.on("theme", (payload) => { theme = payload; });
    globalThis.window.__soksak.event("theme", { dark: true });
    assert.deepEqual(theme, { dark: true });
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("a surface page calls its document command with the surface of its address", async () => {
  const calls = [];
  globalThis.window = channel(calls, new Map([["log", Promise.resolve(policyRead)]]));
  globalThis.location = { search: "?id=s7" };
  try {
    const { page } = await import("../runtime/index.js?test=surface-page");
    await page.document.load("d1", "https://example.com/");
    assert.deepEqual(calls.at(-1), ["document_load", { request: { surface: "s7", document: "d1", url: "https://example.com/" } }]);
    // The event batcher of the page flushes while its channel exists, so the test waits for its turn before it
    // removes the channel.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("the host invoke passes a null argument as null and sends an empty object only for an undefined argument", async () => {
  const calls = [];
  globalThis.window = channel(calls);
  globalThis.location = { search: "" };
  const { hostInvoke } = await import("../runtime/index.js?test=host-invoke");
  const invoke = hostInvoke();
  await invoke("probe", null);
  await invoke("probe", undefined);
  assert.deepEqual(calls, [["probe", null], ["probe", {}]]);
});
