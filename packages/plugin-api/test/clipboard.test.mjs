import assert from "node:assert/strict";
import test from "node:test";
import { ClipboardError, createClipboardBridge, shellQuotePath } from "../clipboard.js";

test("typed clipboard reads distinguish absent values from typed values and transport errors", async () => {
  const calls = [];
  const clipboard = createClipboardBridge(async (name, payload) => {
    calls.push([name, payload]);
    if (payload.type === "text") return { present: true, type: "text", text: "hello" };
    if (payload.type === "png") return { present: true, type: "png", data: "AAEC" };
    return { present: false, type: "fileURLs" };
  });
  assert.equal(await clipboard.read("text"), "hello");
  assert.deepEqual(await clipboard.read("png"), new Uint8Array([0, 1, 2]));
  assert.equal(await clipboard.read("fileURLs"), null);
  await clipboard.writeText("copied");
  assert.deepEqual(calls, [
    ["clipboardRead", { type: "text", userInitiated: true }],
    ["clipboardRead", { type: "png", userInitiated: true }],
    ["clipboardRead", { type: "fileURLs", userInitiated: true }],
    ["clipboardWriteText", "copied"],
  ]);
  await assert.rejects(clipboard.read("bad"), /clipboard type/);
  const failing = createClipboardBridge(async () => { throw new Error("permission denied"); });
  await assert.rejects(failing.read("text"), /permission denied/);
});

test("PNG persistence is an explicit plugin capability and returns an inert shell argument", async () => {
  const calls = [];
  const clipboard = createClipboardBridge(async (name, payload) => {
    calls.push([name, payload]);
    return { path: "/config-owned/clipboard image.png" };
  }, { allowPersist: true });
  const result = await clipboard.persistPNG(new Uint8Array([0, 255, 1]));
  assert.deepEqual(result, {
    path: "/config-owned/clipboard image.png",
    shellQuotedPath: "'/config-owned/clipboard image.png'",
  });
  assert.deepEqual(calls, [["clipboardPersistPNG", { data: "AP8B" }]]);
  assert.equal("execute" in clipboard, false);
  assert.equal("persistPNG" in createClipboardBridge(() => Promise.resolve(null)), false);
  assert.equal(shellQuotePath("a'b"), "'a'\\''b'");
  await assert.rejects(clipboard.persistPNG("not bytes"), /PNG data/);
});

test("malformed clipboard responses are errors, not absent values", async () => {
  const clipboard = createClipboardBridge(async () => ({ present: true, type: "text", text: 1 }));
  await assert.rejects(clipboard.read("text"), ClipboardError);
  await assert.rejects(createClipboardBridge(async () => null).read("text"), /missing or malformed/);
  await assert.rejects(createClipboardBridge(async () => ({ present: false })).read("text"), /absent response type mismatch/);
  await assert.rejects(createClipboardBridge(async () => ({ present: false, type: "png" })).read("text"), /absent response type mismatch/);
});
