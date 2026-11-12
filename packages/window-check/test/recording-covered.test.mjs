import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../app.mjs";

/**
 * A session whose host answers the requests of a recording on a display of 120 Hz, and the requests that it sent with their
 * parameters.
 */
function session({ stopFails = false } = {}) {
  const requests = [];
  const client = {
    endpoint: { pid: 4242 },
    request: async (method, params) => {
      requests.push(method === "diagnostics.window.draw-covered" ? `${method} ${params.draw}` : method);
      if (method === "diagnostics.window.draw-covered") return null;
      if (method === "status.get") return { refreshRate: 120 };
      // The start of a recording of a new window names no window: the application shows it after the start.
      if (method === "diagnostics.capture.start") return { frames: "/unused/frames", window: params.newWindow === true ? null : 7 };
      if (method === "diagnostics.capture.stop" && stopFails) throw new Error("the capture failed");
      throw new Error(`unexpected request ${method}`);
    },
  };
  const s = new Session({ name: "mygo", configDir: "/unused" }, client);
  s.step = () => {};
  s.trackRecording = () => "recording";
  return { s, requests };
}

// A recording reads the window itself, whatever the windows of other applications in front of it, and holds the covered
// drawing until it stops, so the regions of a covered window draw as they do on the screen. It reads no occlusion state.
test("a recording holds the covered drawing of its window from before the capture starts", async () => {
  const { s, requests } = session();
  const recording = await s.record();
  assert.equal(recording.frames, "/unused/frames");
  assert.deepEqual(requests, ["status.get", "diagnostics.window.draw-covered true", "diagnostics.capture.start"]);
});

test("the stop of a recording ends its hold of the covered drawing, also when the stop fails", async () => {
  const { s, requests } = session({ stopFails: true });
  const recording = await s.record();
  await assert.rejects(recording.stop({ after: 0 }), /the capture failed/);
  assert.deepEqual(requests, ["status.get", "diagnostics.window.draw-covered true", "diagnostics.capture.start",
    "diagnostics.capture.stop", "diagnostics.window.draw-covered false"]);
});

// A recording of a new window (newWindow) reads a window that the application creates after the start answers, so the covered
// drawing of the requesting window is not its concern: the start goes to the host without that hold, and the stop ends nothing.
test("a recording of a new window starts without a hold of the covered drawing of the requesting window", async () => {
  const { s, requests } = session();
  const recording = await s.record({ newWindow: true });
  assert.equal(recording.frames, "/unused/frames");
  assert.deepEqual(requests, ["status.get", "diagnostics.capture.start"]);
  await assert.rejects(recording.stop({ after: 0 }), /unexpected request diagnostics.capture.stop/);
  assert.deepEqual(requests, ["status.get", "diagnostics.capture.start", "diagnostics.capture.stop"]);
});
