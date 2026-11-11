import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../app.mjs";

/** A session whose host answers the requests of a recording, and the requests that it sent with their parameters. */
function session({ stopFails = false } = {}) {
  const requests = [];
  const client = {
    endpoint: { pid: 4242 },
    request: async (method, params) => {
      requests.push(method === "diagnostics.window.draw-covered" ? `${method} ${params.draw}` : method);
      if (method === "diagnostics.window.draw-covered") return null;
      if (method === "diagnostics.capture.start") return { frames: "/unused/frames" };
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
  const recording = await s.record({ frameIdentity: true });
  assert.equal(recording.frames, "/unused/frames");
  assert.deepEqual(requests, ["diagnostics.window.draw-covered true", "diagnostics.capture.start"]);
});

test("the stop of a recording ends its hold of the covered drawing, also when the stop fails", async () => {
  const { s, requests } = session({ stopFails: true });
  const recording = await s.record();
  await assert.rejects(recording.stop({ after: 0 }), /the capture failed/);
  assert.deepEqual(requests, ["diagnostics.window.draw-covered true", "diagnostics.capture.start", "diagnostics.capture.stop",
    "diagnostics.window.draw-covered false"]);
});
