import assert from "node:assert/strict";
import test from "node:test";

test("Tauri runtime exposes the typed clipboard bridge with scoped host commands", async () => {
  const calls = [];
  globalThis.window = {
    __TAURI__: {
      core: { invoke: (command, args) => {
        calls.push([command, args]);
        if (command === "clipboard_read") return Promise.resolve({ present: false, type: "text" });
        return Promise.resolve({ path: "/config/clip.png" });
      } },
      event: { listen: () => Promise.resolve(() => {}) },
      webview: { getCurrentWebview: () => ({ label: "main" }) },
    },
  };
  globalThis.location = { search: "" };
  const { clipboard } = await import(`../runtime/index.js?clipboard=${Date.now()}`);
  assert.equal(await clipboard.read("text"), null);
  await clipboard.writeText("copied");
  assert.deepEqual(await clipboard.persistPNG(new Uint8Array([1, 2])), {
    path: "/config/clip.png", shellQuotedPath: "'/config/clip.png'",
  });
  assert.deepEqual(calls, [
    ["clipboard_read", { request: { type: "text", userInitiated: true } }],
    ["clipboard_write_text", { text: "copied" }],
    ["clipboard_persist_png", { request: { data: "AQI=" } }],
  ]);
  const { host } = await import(`../runtime/index.js?clipboard=${Date.now()}`);
  calls.length = 0;
  await host.call("clipboardReadViewPNG", { surface: "view-surface", userInitiated: true });
  await host.call("clipboardPersistViewPNG", { surface: "view-surface", binary: "0123456789abcdef0123456789abcdef" });
  assert.deepEqual(calls, [
    ["clipboard_read_view_png", { request: { surface: "view-surface", userInitiated: true } }],
    ["clipboard_persist_view_png", { request: { surface: "view-surface", binary: "0123456789abcdef0123456789abcdef" } }],
  ], "the PNG calls of a view reach the host commands of the view binary store");
  delete globalThis.window;
  delete globalThis.location;
});
