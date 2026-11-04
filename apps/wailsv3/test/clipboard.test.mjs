import assert from "node:assert/strict";
import test from "node:test";

test("Wails runtime exposes the typed clipboard bridge with scoped host methods", async () => {
  const calls = [];
  globalThis.window = {
    __soksakNative: {
      call: (method, args) => {
        calls.push([method, args]);
        return Promise.resolve(method === "ClipboardRead" ? { present: true, type: "text", text: "paste" } : { path: "/config/clip.png" });
      },
      on: () => Promise.resolve(() => {}),
    },
  };
  globalThis.location = { search: "" };
  globalThis.URLSearchParams = class { get() { return null; } };
  const { clipboard } = await import(`../runtime/index.js?clipboard=${Date.now()}`);
  assert.equal(await clipboard.read("text"), "paste");
  await clipboard.writeText("copied");
  assert.deepEqual(await clipboard.persistPNG(new Uint8Array([3])), {
    path: "/config/clip.png", shellQuotedPath: "'/config/clip.png'",
  });
  assert.deepEqual(calls, [
    ["ClipboardRead", [{ type: "text", userInitiated: true }]],
    ["ClipboardWriteText", ["copied"]],
    ["ClipboardPersistPNG", [{ data: "Aw==" }]],
  ]);
  const { host } = await import(`../runtime/index.js?clipboard=${Date.now()}`);
  calls.length = 0;
  await host.call("clipboardReadViewPNG", { surface: "view-surface", userInitiated: true });
  await host.call("clipboardPersistViewPNG", { surface: "view-surface", binary: "0123456789abcdef0123456789abcdef" });
  assert.deepEqual(calls, [
    ["ClipboardReadViewPNG", [{ surface: "view-surface", userInitiated: true }]],
    ["ClipboardPersistViewPNG", [{ surface: "view-surface", binary: "0123456789abcdef0123456789abcdef" }]],
  ], "the PNG calls of a view reach the host methods of the view binary store");
  delete globalThis.window;
  delete globalThis.location;
  delete globalThis.URLSearchParams;
});
