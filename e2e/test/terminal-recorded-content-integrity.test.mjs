import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { frames } from "@soksak/window-check/frame.mjs";
import { loadTerminalReferenceFixture } from "./terminal-reference-fixture.mjs";
import { readTerminalRecordedFrames } from "../terminal-recorded-content.mjs";

const idle = JSON.parse(readFileSync(new URL("./fixtures/capture-idle-callbacks.json", import.meta.url), "utf8"));
test("normal terminal recording retains idle callbacks and maps every complete frame once", t => {
  const input = loadTerminalReferenceFixture(t);
  for (const row of idle) input.callbacks.push({ ...row, sequence: input.callbacks.length + 1 });
  writeFileSync(join(input.captureDirectory, "callback-status.jsonl"), input.callbacks.map(row => JSON.stringify(row)).join("\n") + "\n");
  const before = readFileSync(input.evidence.capture.callbackStatus, "utf8");
  const paths = frames(input.captureDirectory);
  assert.equal(readTerminalRecordedFrames(input.evidence.capture, paths).length, paths.length);
  assert.equal(readFileSync(input.evidence.capture.callbackStatus, "utf8"), before);
});
