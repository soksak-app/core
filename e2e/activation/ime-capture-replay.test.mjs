import assert from "node:assert/strict";
import test from "node:test";
import { parseReplayArgs } from "./ime-capture-replay.mjs";

test("offline IME replay requires explicit artifact and result paths", { timeout: 5000 }, () => {
  assert.throws(() => parseReplayArgs([]), /--artifact-dir is required/);
  assert.throws(() => parseReplayArgs(["--artifact-dir", "/tmp/capture"]), /--result-file is required/);
  assert.throws(() => parseReplayArgs(["--artifact-dir", "/tmp/capture", "--result-file"]),
    /--result-file requires a path/);
  assert.deepEqual(parseReplayArgs(["--artifact-dir", "/tmp/capture", "--result-file", "/tmp/result.json"]),
    { artifactDir: "/tmp/capture", resultFile: "/tmp/result.json" });
});
