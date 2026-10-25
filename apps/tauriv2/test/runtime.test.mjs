import assert from "node:assert/strict";
import test from "node:test";

// A document of a surface asks the host for the log policy at its load (action policy-read); the fake host answers it with the
// default policy and does not record it.
const policyRead = { classes: { lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" } };

test("surface readiness invokes the registered native presentation command", async () => {
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push([command, args]); return 42; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js");
    assert.equal(await host.call("waitPresented"), 42);
    assert.deepEqual(calls, [["wait_presented", {}]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("ordered main events register before subscribers proceed and dispatch through one channel", async () => {
  const calls = [];
  const listeners = [];
  const channels = [];
  let finishRegistration;
  class Channel {
    constructor() {
      channels.push(this);
      this.onmessage = null;
    }
  }
  globalThis.window = { __TAURI__: {
    core: {
      Channel,
      invoke: (command, args) => {
        calls.push([command, args]);
        if (command === "declared_source_event_stream") {
          return new Promise((resolve) => { finishRegistration = resolve; });
        }
        return Promise.resolve(null);
      },
    },
    event: { listen: async (event, fn) => { listeners.push([event, fn]); return () => {}; } },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?test=ordered-main-events");
    const delivered = [];
    const eventNames = [
      "declared-ui-source-registered", "declared-ui-source-ended", "declared-ui-snapshot",
      "plugin-host-call", "plugin-host-reply", "plugin-host-ended",
      "view-call", "view-reply", "view-process-ended", "view-stopped", "view-responsiveness",
    ];
    let queryStarted = false;
    const registrations = Promise.all(eventNames.map((name) => host.on(name, (value) => delivered.push([name, value]))));
    const query = registrations.then(() => { queryStarted = true; });
    await Promise.resolve();
    assert.equal(queryStarted, false, "provider query waits for the main event stream registration");
    assert.equal(channels.length, 1, "all ordered event names share one channel");
    assert.equal(typeof channels[0].onmessage, "function", "the channel receiver is assigned before registration");
    eventNames.forEach((name, index) => channels[0].onmessage({ name, value: { index } }));
    assert.deepEqual(delivered, eventNames.map((name, index) => [name, { index }]),
      "all source, snapshot, call, reply, and end events share Channel order and preserve payloads");
    finishRegistration(null);
    await query;
    assert.deepEqual(calls, [["declared_source_event_stream", { onMessage: channels[0] }]]);
    assert.deepEqual(listeners, [], "ordered events do not use the unordered event/eval path");

    const nonOrdered = host.on("workspace-changed", () => {});
    await nonOrdered;
    assert.equal(listeners[0][0], "workspace-changed", "other host events keep the existing listener API");
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("ordered listener registration failure rejects instead of falling back to unordered events", async () => {
  const calls = [];
  const listeners = [];
  class Channel {
    constructor() { this.onmessage = null; }
  }
  globalThis.window = { __TAURI__: {
    core: {
      Channel,
      invoke: async (command, args) => {
        calls.push([command, args]);
        if (command === "declared_source_event_stream") throw "channel registration failed";
        return null;
      },
    },
    event: { listen: async (event, fn) => { listeners.push([event, fn]); return () => {}; } },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?test=ordered-registration-failure");
    await assert.rejects(host.on("declared-ui-source-registered", () => {}),
      (error) => error instanceof Error && error.message === "channel registration failed");
    assert.equal(calls[0]?.[0], "declared_source_event_stream");
    assert.deepEqual(listeners, [], "registration failure does not fall back to unordered events");
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("ordered event listener errors are reported without blocking later subscribers or messages", async () => {
  const channels = [];
  const errors = [];
  const received = [];
  class Channel {
    constructor() { channels.push(this); }
  }
  globalThis.window = { __TAURI__: {
    core: {
      Channel,
      invoke: async () => null,
    },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  globalThis.dispatchEvent = (event) => { errors.push(event); return true; };
  try {
    const { host } = await import("../runtime/index.js?test=ordered-listener-error");
    let first = true;
    await Promise.all([
      host.on("view-call", () => {
        if (first) {
          first = false;
          throw new Error("subscriber failed");
        }
      }),
      host.on("view-call", (value) => received.push(value)),
    ]);
    assert.doesNotThrow(() => channels[0].onmessage({ name: "view-call", value: "one" }));
    assert.doesNotThrow(() => channels[0].onmessage({ name: "view-call", value: "two" }));
    assert.deepEqual(received, ["one", "two"], "a failing subscriber does not block fanout or the next channel item");
    assert.equal(errors.length, 1, "the failing subscriber is reported once");
    assert.match(errors[0].message, /native event view-call: subscriber failed/);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
    delete globalThis.dispatchEvent;
  }
});

test("a late view notification without a surface subscriber does not block later events", async () => {
  const channels = [];
  const errors = [];
  const received = [];
  class Channel {
    constructor() { channels.push(this); }
  }
  globalThis.window = { __TAURI__: {
    core: { Channel, invoke: async () => null },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  globalThis.dispatchEvent = (event) => { errors.push(event); return true; };
  try {
    const { host } = await import("../runtime/index.js?test=ordered-empty-subscriber");
    await host.on("view-call", (value) => received.push(value));
    assert.doesNotThrow(() => channels[0].onmessage({
      name: "view-responsiveness", value: { surface: "closed-surface", responsive: false },
    }));
    channels[0].onmessage({ name: "view-call", value: { id: "current-call" } });
    assert.deepEqual(received, [{ id: "current-call" }]);
    assert.deepEqual(errors, [], "a notification with no remaining surface listener is not a malformed event");
  } finally {
    delete globalThis.window;
    delete globalThis.location;
    delete globalThis.dispatchEvent;
  }
});


test("a reloaded main page registers a fresh ordered channel", async () => {
  const calls = [];
  const channels = [];
  const received = [];
  const pageListeners = new Map();
  class Channel {
    constructor() { channels.push(this); }
  }
  const makeWindow = () => ({
    __TAURI__: {
      core: {
        Channel,
        invoke: async (command, args) => { calls.push([command, args]); return null; },
      },
      event: { listen: async () => () => {} },
      webview: { getCurrentWebview: () => ({ label: "main" }) },
    },
    addEventListener: (event, fn) => {
      if (!pageListeners.has(event)) pageListeners.set(event, []);
      pageListeners.get(event).push(fn);
    },
  });
  globalThis.window = makeWindow();
  globalThis.location = { search: "" };
  try {
    const first = await import("../runtime/index.js?test=ordered-channel-reload-first");
    await first.host.on("declared-ui-source-registered", (event) => received.push(["old", event]));
    for (const listener of pageListeners.get("pagehide") ?? []) listener();
    channels[0].onmessage({ name: "declared-ui-source-registered", value: { plugin: "stale", generation: 1 } });
    assert.deepEqual(received, [], "pagehide releases the old page's local event subscription");
    globalThis.window = makeWindow();
    const second = await import("../runtime/index.js?test=ordered-channel-reload-second");
    await second.host.on("declared-ui-source-registered", (event) => received.push(["new", event]));
    channels[1].onmessage({ name: "declared-ui-source-registered", value: { plugin: "current", generation: 2 } });
    assert.equal(channels.length, 2);
    assert.notEqual(channels[0], channels[1], "a new page instance registers its own Channel");
    assert.deepEqual(received, [["new", { plugin: "current", generation: 2 }]]);
    assert.deepEqual(calls.map(([command]) => command), ["declared_source_event_stream", "declared_source_event_stream"]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("ordered stream refuses unknown event names through the page error path", async () => {
  const channels = [];
  const errors = [];
  class Channel {
    constructor() { channels.push(this); }
  }
  globalThis.window = { __TAURI__: {
    core: { Channel, invoke: async () => null },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  globalThis.dispatchEvent = (event) => { errors.push(event); return true; };
  try {
    const { host } = await import("../runtime/index.js?test=unknown-ordered-event");
    await host.on("view-call", () => {});
    channels[0].onmessage({ name: "undeclared-event", value: {} });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /ordered stream.*unknown event undeclared-event/);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
    delete globalThis.dispatchEvent;
  }
});

test("every host command has an argument mapping, so a call never throws before it is sent", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../runtime/index.js", import.meta.url), "utf8");
  const block = (name) => source.slice(source.indexOf(`const ${name} = {`), source.indexOf("\n};", source.indexOf(`const ${name} = {`)));
  const commands = [...block("COMMAND").matchAll(/(\w+):\s*"/g)].map((match) => match[1]).sort();
  const mapped = [...block("ARG").matchAll(/(\w+):\s*\(/g)].map((match) => match[1]).sort();
  assert.ok(commands.includes("notificationState"), `the command list was not read: ${commands.join(", ")}`);
  assert.deepEqual(commands.filter((name) => !mapped.includes(name)), [], "commands without an argument mapping");
  assert.deepEqual(mapped.filter((name) => !commands.includes(name)), [], "argument mappings without a command");
});

test("the performance trace command carries the page request to the host", async () => {
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push([command, args]); return null; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    // Only this check uses a separate copy of the module, because the runtime captures window on its first load.
    const { host } = await import("../runtime/index.js?test=performance-command");
    await host.call("performance", { action: "on" });
    assert.deepEqual(calls, [["performance", { request: { action: "on" } }]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("a failed host call rejects with an Error that carries the host's message", async () => {
  globalThis.window = { __TAURI__: {
    core: { invoke: async () => { throw "lstat /missing: no such file or directory"; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?string-error");
    await assert.rejects(host.call("projectFolder", "/missing"),
      (error) => error instanceof Error && error.message === "lstat /missing: no such file or directory");
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("a page sidecar failure reaches only the listener of that sidecar and surface", async () => {
  const listeners = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { if (command === "log" && args.request.action === "policy-read") return Promise.resolve(policyRead); return null; } },
    event: { listen: async (event, fn) => { listeners.push([event, fn]); return () => {}; } },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "?id=s1" };
  try {
    // Only this check uses a separate copy of the module, because the runtime captures window on its first load.
    const { page } = await import("../runtime/index.js?test=sidecar-failure");
    const reasons = [];
    const off = await page.sidecar("@x/side").onFailure("s1", (reason) => reasons.push(reason));
    assert.equal(typeof off, "function");
    const [event, deliver] = listeners.at(-1);
    assert.equal(event, "sidecar-failure");
    deliver({ payload: { sidecar: "@x/side", surface: "s2", reason: "another surface" } });
    deliver({ payload: { sidecar: "@x/other", surface: "s1", reason: "another sidecar" } });
    deliver({ payload: { sidecar: "@x/side", surface: "s1", reason: "output closed: exit status 3" } });
    assert.deepEqual(reasons, ["output closed: exit status 3"]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("the log command carries the page batch to the host", async () => {
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push([command, args]); return null; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?test=log-command");
    await host.call("log", { action: "batch", events: [] });
    assert.deepEqual(calls, [["log", { request: { action: "batch", events: [] } }]]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("a call of the main page that carries out an operation sends its identifiers beside the arguments of the command", async () => {
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push([command, args]); return null; } },
    event: { listen: async () => () => {} },
    webview: { getCurrentWebview: () => ({ label: "main" }) },
  } };
  globalThis.location = { search: "" };
  try {
    const { host } = await import("../runtime/index.js?test=main-cids");
    await host.call("windowNew", undefined, { cids: ["p1.1"] });
    await host.call("pluginsRun", { action: "install", plugin: "term" }, { cids: ["p1.2"] });
    await host.call("pluginsStarter", { state: "pending", pack: "starter", registry: "file:///registry/index.json", plugins: ["term"] });
    await host.call("windowReady");
    assert.deepEqual(calls, [
      ["window_new", { cids: ["p1.1"] }],
      ["plugins_run", { request: { action: "install", plugin: "term" }, cids: ["p1.2"] }],
      ["plugins_starter", { request: { state: "pending", pack: "starter", registry: "file:///registry/index.json", plugins: ["term"] } }],
      ["window_ready", {}],
    ]);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});
