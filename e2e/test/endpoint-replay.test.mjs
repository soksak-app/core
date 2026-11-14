// The replay of the endpoint contract cases (e2e/endpoint-replay.mjs) against a player of a case: a still that a replayed case
// requests is a folder that the host writes in the configuration folder of the session, and the session of the check tracks it, so
// the audit of the session finds no folder that the check left untracked.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { connect } from "@soksak/client";
import { readCase, startCasePlayer } from "@soksak/client/testing";
import { finishSession, recordingFolders, Session } from "@soksak/window-check/app.mjs";
import { replay } from "../endpoint-replay.mjs";

const OPEN = JSON.stringify({ ts_us: 1791000000000000, seq: 1, level: "info", layer: "host", event: "log.open", fields: { schema: 3 } });

test("a replayed still case leaves no untracked still folder", { timeout: 10000 }, async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-endpoint-replay-"));
  mkdirSync(join(configDir, "logs"));
  writeFileSync(join(configDir, "logs", "host-1-1.jsonl"), `${OPEN}\n`);
  const path = join(configDir, "logs", "captures", "still-main-1", "window.png");
  const player = await startCasePlayer("capture-still", { values: { path } });
  t.after(() => player.close());
  copyFileSync(join(player.configDir, "endpoint.json"), join(configDir, "endpoint.json"));
  // The player answers for the host, so the test writes the still that the host writes when it receives the request. The player
  // sends the reply and then announces the request in the same turn, and the replay reads the reply in a later turn.
  player.events.on("request", (message) => {
    if (message.method !== "diagnostics.capture.still") return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "PNG");
  });
  const client = await connect({ configDir });
  const session = new Session({ name: "wailsv3", configDir }, client);
  session.eventStart = {};
  session.recordingsBefore = recordingFolders(configDir);
  // The session audit judges the check when the test has ended, as open() registers it, so it runs in the after hook.
  t.after(async () => {
    try {
      await finishSession(t, session, () => client.close());
      assert.deepEqual(recordingFolders(configDir), [], "the session kept the still folder of a passed check");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
  const { address } = client.endpoint;
  const { problems, bound } = await replay(session, await readCase("capture-still"), address);
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.equal(bound.path, path, "the replay bound another still path than the host answered");
});
