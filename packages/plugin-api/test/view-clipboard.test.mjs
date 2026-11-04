// Checks runtime.clipboard of createViewBridge over a jsdom window on soksak://probe/. A PNG of a view call travels through the
// binary path of the view (docs/spec/plugin-processes.md#binary-path): persistPNG uploads the bytes and sends their id, and a png read
// downloads the bytes of the id that the reply names. The fetch of the window is a fake that records each request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge } from "../view.js";

const BINARY_ID = "0123456789abcdef0123456789abcdef";

// Lets every pending promise of the call layer settle.
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Runs body(view) with a bridge on a jsdom window. view.posted holds the call messages, view.fetched each fetch {url, method, type,
 * body}, view.respond(response) sets the answer of the next fetch {status, json} or {status, bytes}, and view.answer(answer) answers the
 * last posted call.
 */
async function withView(body) {
  const dom = new JSDOM("", { url: "soksak://probe/", runScripts: "outside-only" });
  const posted = [];
  const fetched = [];
  const responses = [];
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true, writable: true });
  try {
    dom.window.webkit = { messageHandlers: { "sok-view": { postMessage: () => {} } } };
    dom.window.sokTheme = { scheme: "dark", tokens: {} };
    dom.window.eval(readFileSync(new URL("../view-start.js", import.meta.url), "utf8"));
    dom.window.fetch = async (url, init = {}) => {
      fetched.push({
        url,
        method: init.method ?? "GET",
        type: init.headers?.["Content-Type"] ?? null,
        body: init.body === undefined ? null : [...new Uint8Array(init.body)],
      });
      const response = responses.shift();
      if (!response) throw new Error(`no response for ${url}`);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.json,
        arrayBuffer: async () => new Uint8Array(response.bytes).buffer,
      };
    };
    const bridge = createViewBridge({
      handler: { postMessage: (message) => posted.push(structuredClone(message)) },
      report: () => {},
    });
    posted.splice(0);
    const host = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: dom.window }));
    await body({
      clipboard: bridge.runtime.clipboard,
      posted,
      fetched,
      respond: (response) => responses.push(response),
      answer: async (answer) => {
        await settle();
        host({ sok: 1, id: posted.at(-1).id, ...answer });
      },
    });
  } finally {
    delete globalThis.window;
    dom.window.close();
  }
}

test("a png read downloads the bytes of the binary id that the reply names", async () => {
  await withView(async (view) => {
    view.respond({ status: 200, bytes: [1, 2, 3] });
    const read = view.clipboard.read("png");
    await view.answer({ result: { present: true, type: "png", binary: BINARY_ID } });
    const bytes = await read;
    assert.ok(bytes instanceof Uint8Array, "the read returns bytes");
    assert.deepEqual([...bytes], [1, 2, 3]);
    assert.deepEqual(view.posted.map(({ command, params }) => ({ command, params })),
      [{ command: "runtime.clipboard.read", params: "png" }]);
    assert.deepEqual(view.fetched, [{ url: `soksak://probe/.binary/${BINARY_ID}`, method: "GET", type: null, body: null }]);
  });
});

test("a png read returns null when the clipboard holds no png, and refuses a reply without a binary id", async () => {
  await withView(async (view) => {
    const absent = view.clipboard.read("png");
    await view.answer({ result: null });
    assert.equal(await absent, null);
    const malformed = view.clipboard.read("png");
    await view.answer({ result: { present: true, type: "png", data: "AQID" } });
    await assert.rejects(malformed, /clipboard png reply is invalid: \{"present":true,"type":"png","data":"AQID"\}/);
    assert.deepEqual(view.fetched, [], "no download runs");
  });
});

test("a failed download rejects the png read with its status and error", async () => {
  await withView(async (view) => {
    view.respond({ status: 404, json: { error: `binary id ${BINARY_ID} is not stored` } });
    const read = view.clipboard.read("png");
    await view.answer({ result: { present: true, type: "png", binary: BINARY_ID } });
    await assert.rejects(read, new RegExp(`binary download of ${BINARY_ID} failed with 404: binary id ${BINARY_ID} is not stored`));
  });
});

test("persistPNG uploads the bytes as image/png and sends the binary id of the upload", async () => {
  await withView(async (view) => {
    view.respond({ status: 200, json: { id: BINARY_ID, length: 3 } });
    const persisted = view.clipboard.persistPNG(new Uint8Array([7, 8, 9]));
    await settle();
    assert.deepEqual(view.fetched, [{ url: "soksak://probe/.binary", method: "POST", type: "image/png", body: [7, 8, 9] }]);
    await view.answer({ result: { path: "/tmp/clip.png", shellQuotedPath: "'/tmp/clip.png'" } });
    assert.deepEqual(await persisted, { path: "/tmp/clip.png", shellQuotedPath: "'/tmp/clip.png'" });
    assert.deepEqual(view.posted.map(({ command, params }) => ({ command, params })),
      [{ command: "runtime.clipboard.persistPNG", params: { binary: BINARY_ID } }]);
  });
});

test("a refused upload rejects persistPNG and sends no call, and bytes of another type are refused", async () => {
  await withView(async (view) => {
    view.respond({ status: 413, json: { error: "the upload is over the limit of 16777216 bytes" } });
    await assert.rejects(view.clipboard.persistPNG(new Uint8Array([1])),
      /binary upload failed with 413: the upload is over the limit of 16777216 bytes/);
    await assert.rejects(view.clipboard.persistPNG("AQID"), /persistPNG requires the PNG bytes as a Uint8Array or an ArrayBuffer/);
    await settle();
    assert.deepEqual(view.posted, [], "no persist call is sent");
  });
});

test("a text read and writeText are calls of the view", async () => {
  await withView(async (view) => {
    const read = view.clipboard.read("text");
    await view.answer({ result: "copied" });
    assert.equal(await read, "copied");
    const written = view.clipboard.writeText("pasted");
    await view.answer({ result: null });
    assert.equal(await written, undefined);
    assert.deepEqual(view.posted.map(({ command, params }) => ({ command, params })),
      [{ command: "runtime.clipboard.read", params: "text" }, { command: "runtime.clipboard.writeText", params: "pasted" }]);
    assert.deepEqual(view.fetched, []);
  });
});
