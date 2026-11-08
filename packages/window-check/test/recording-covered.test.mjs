import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

// The window list of the system is not read: one window of another application covers the fake window whole.
const frontmost = await import("../frontmost.mjs");
const COVER = { owner: "another application", frame: { x: 0, y: 0, width: 1800, height: 1000 } };
mock.module(pathToFileURL(new URL("../frontmost.mjs", import.meta.url).pathname).href, {
  namedExports: { ...frontmost, coveringWindows: () => [COVER] },
});
const { Session } = await import("../app.mjs");

/** A session whose host.window reports `occluded`, and the requests that it sent. */
function session(occluded) {
  const requests = [];
  const client = {
    endpoint: { pid: 4242 },
    request: async (method, params) => {
      requests.push(params?.name ? `${method} ${params.name}` : method);
      if (method === "status.get" && params.name === "host.window") {
        return { occluded, frame: { x: 300, y: 39, width: 1200, height: 760 } };
      }
      if (method === "diagnostics.capture.start") return { frames: "/unused/frames" };
      throw new Error(`unexpected request ${method}`);
    },
  };
  const s = new Session({ name: "mygo", configDir: "/unused" }, client);
  s.step = () => {};
  s.trackRecording = () => "recording";
  return { s, requests };
}

// Frame identity is decoded from the captured pixels of the window, and WebKit renders a window that is covered whole less
// often, so a frame identity recording of such a window is refused before it starts, naming the covering window.
test("a frame identity recording of a window that is covered whole is refused before the capture starts", async () => {
  const { s, requests } = session(true);
  await assert.rejects(s.record({ frameIdentity: true }),
    /mygo's window is completely covered by another application at .*Nothing was measured: uncover the window/);
  assert.deepEqual(requests, ["status.get host.window"]);
});

test("a frame identity recording of a window that the screen shows starts the capture", async () => {
  const { s, requests } = session(false);
  const recording = await s.record({ frameIdentity: true });
  assert.equal(recording.frames, "/unused/frames");
  assert.deepEqual(requests, ["status.get host.window", "diagnostics.capture.start"]);
});
