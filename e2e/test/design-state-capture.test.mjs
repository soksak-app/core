import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import * as still from "../still-capture.mjs";

function pngChunk(type, body) {
  const bytes = Buffer.concat([Buffer.from(type), body]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length); bytes.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "soksak-design-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "native", "still-main-1", "window.png");
  mkdirSync(dirname(source), { recursive: true });
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 10, 20, 30, 255]))), pngChunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(source, bytes);
  const owned = [], events = [];
  const session = { app: { name: "fixture-host" },
    request: async (method, params) => { events.push("capture"); assert.equal(method, "diagnostics.capture.still"); assert.deepEqual(params, {}); return { path: source }; },
    trackRecording: path => { events.push("owned"); owned.push(path); assert.ok(existsSync(source)); },
  };
  return { root, source, bytes, owned, events, session, diagnostics: { diagnostic() {} } };
}
async function retain(...args) {
  assert.equal(typeof still.retainDesignStateCapture, "function", "the in-state design capture retention helper is required");
  return still.retainDesignStateCapture(...args);
}

test("design state capture owns its source and retains the exact PNG after session cleanup", async t => {
  const f = fixture(t), runFolder = join(f.root, "declared-run");
  const result = await retain(f.session, f.diagnostics, "space rename", { runFolder });
  assert.deepEqual(f.events, ["capture", "owned"]);
  assert.deepEqual(f.owned, [dirname(f.source)]);
  assert.equal(result.path, join(runFolder, "design-hosts", "fixture-host", "space rename.png"));
  assert.ok(existsSync(f.source), "retention must not unlink the session-owned source early");
  assert.deepEqual(readFileSync(result.path), f.bytes);
  rmSync(dirname(f.source), { recursive: true });
  assert.deepEqual(readFileSync(result.path), f.bytes, "normal source cleanup must not remove retained visual evidence");
});
test("design state capture requires the declared run folder before acquiring a native capture", async t => {
  const f = fixture(t);
  await assert.rejects(() => retain(f.session, f.diagnostics, "project rename", { runFolder: "" }), /SOKSAK_RUN_FOLDER/);
  assert.deepEqual(f.events, []);
});
