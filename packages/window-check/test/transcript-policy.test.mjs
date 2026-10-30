// F292-9-4: the page sends the transcript lines as the record page.record.info, so a transcript under a log policy that does not
// store that record is refused at once with an error that names the record and the policy, instead of a wait that ends only at
// its deadline with no line.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "../app.mjs";

const CATALOG = { events: {
  "page.record.<level>": { layer: "page", class: "lifecycle", level: ["error", "info"] },
} };

/** A session of a configuration folder whose policy file holds `classes`, and the methods that its client was asked. */
function session(t, classes) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-transcript-policy-"));
  t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, "log-policy.json"), JSON.stringify({ schema: 1, classes }));
  const asked = [];
  const client = {
    endpoint: { pid: process.pid },
    on: () => () => {},
    request: async (method) => {
      asked.push(method);
      return null;
    },
  };
  return { s: new Session({ name: "probe", configDir: dir }, client), asked, dir };
}

test("a transcript under a policy that does not store page.record.info is refused at once", async (t) => {
  const { s, asked, dir } = session(t, { lifecycle: "error", input: "error", call: "debug", io: "error", frame: "error" });
  await assert.rejects(s.transcript(CATALOG), {
    message: "the check reads page.record.info (class lifecycle, level info), which the log policy " +
      `{"lifecycle":"error","input":"error","call":"debug","io":"error","frame":"error"} of ${join(dir, "log-policy.json")} does not store`,
  });
  assert.deepEqual(asked, [], "the refused transcript turned the transcript of the page on");
});

test("a transcript under a policy that stores page.record.info turns the transcript of the page on", async (t) => {
  const { s, asked } = session(t, { lifecycle: "info", input: "error", call: "debug", io: "error", frame: "error" });
  const transcript = await s.transcript(CATALOG);
  assert.deepEqual(await transcript.stop(), []);
  assert.deepEqual(asked, ["diagnostics.transcript", "diagnostics.transcript"]);
});

test("a transcript without the catalog of its record is refused", async (t) => {
  const { s, asked } = session(t, { lifecycle: "info", input: "error", call: "error", io: "error", frame: "error" });
  await assert.rejects(s.transcript(),
    { message: "transcript: give the catalog that declares page.record.info, the record of the transcript lines" });
  assert.deepEqual(asked, []);
});
