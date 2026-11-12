// Integration ownership belongs to e2e: the public window-check SDK owns
// session disposal, and this layer owns acquiring the still artifact, which is evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const app = import.meta.resolve("@soksak/window-check/app.mjs");
const stillCapture = new URL("../still-capture.mjs", import.meta.url).href;
const event = (seq, level, name, fields, layer = "host") =>
  JSON.stringify({ ts_us: 1791000000000000 + seq, seq, level, layer, event: name, fields });
const OPEN = event(1, "info", "log.open", { schema: 3 });
function writeEventLog(dir, lines) {
  const before = `${lines.before.join("\n")}\n`;
  writeFileSync(join(dir, "logs", "host-1-1.jsonl"), `${before}${lines.during.join("\n")}${lines.during.length ? "\n" : ""}`);
  return Buffer.byteLength(before);
}

for (const failed of [true, false]) test(`an acquired still ${failed ? "preserves exact evidence on failure" : "is cleaned only when the whole check succeeds"}`, { timeout: 30000 }, t => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-still-failure-"));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, "logs"));
  writeEventLog(dir, { before: [OPEN], during: [] });
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, `import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Session, finishSession, recordingFolders } from ${JSON.stringify(app)};
import { readStillCapture } from ${JSON.stringify(stillCapture)};
test("probe acquires a still", async t => {
  const configDir = ${JSON.stringify(dir)};
  const path = join(configDir, "logs", "captures", "still-main-1", "window.png");
  const client = { endpoint: { pid: process.pid }, request: async method => {
    assert.equal(method, "diagnostics.capture.still");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "original PNG bytes");
    return { path };
  } };
  const session = new Session({ name: "probe", configDir }, client);
  session.eventStart = {}; session.expectedErrors = [];
  session.markTest = async () => null;
  session.recordingsBefore = recordingFolders(configDir);
  t.after(() => finishSession(t, session, () => {}));
  assert.equal((await readStillCapture(session, t)).path, path);
  ${failed ? 'throw new Error("probe keeps the evidence of a failed check");' : ''}
});
`);
  const { NODE_TEST_CONTEXT, ...environment } = process.env;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file],
    { encoding: "utf8", timeout: 20000, env: { ...environment, FORCE_COLOR: "0" } });
  assert.equal(result.status, failed ? 1 : 0, result.stdout + result.stderr);
  if (failed) assert.match(result.stdout, /probe keeps the evidence of a failed check/, result.stdout + result.stderr);
  const path = join(dir, "logs", "captures", "still-main-1", "window.png");
  if (failed) {
    assert.equal(readFileSync(path, "utf8"), "original PNG bytes");
    assert.match(result.stdout, /kept recording: .*captures\/still-main-1/);
  } else assert.deepEqual(readdirSync(join(dir, "logs", "captures")), []);
});
