// Checks that a terminal session replays from the event log of the application with every stored hash equal
// (docs/spec/replay.md#command): the sidecar frame records and the page frame records that the terminal plugin stores for each
// screen message it receives. A message changed between the sidecar and the page, which the diagnostic command
// `terminal.screen.alter` of the terminal plugin injects, is reported as a divergence of the layer `plugin`. The check runs
// `sok debug replay` of the application bundle, so each host checks its own tool.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, untilEventLines } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

// Waits until the event files hold a page frame record of the session and the sidecar frame record of the same sequence, and
// returns the greatest such sequence. The terminal plugin, the page batch and the sidecar each write at their own interval, so
// the replay compares the records up to a sequence that both layers have stored.
async function storedSequence(app, offsets, session) {
  let sequence = 0;
  await untilEventLines(app.configDir, offsets, () => {
    const { events } = readEvents(app.configDir, offsets);
    const sidecar = new Set(events.filter((event) => event.event === "sidecar.vt.frame" && event.session === session)
      .map((event) => event.fields.sequence));
    const page = events.filter((event) => event.event === "plugin.terminal.frame" && event.fields.session === session)
      .map((event) => event.fields.sequence).filter((value) => sidecar.has(value));
    sequence = Math.max(0, ...page);
    return sequence >= 2;
  }, 20000);
  return sequence;
}

// Runs `sok debug replay` of the bundle and returns its exit status, standard output and standard error.
function replay(app, session, until) {
  const sok = join(dirname(app.binary), "sok");
  try {
    const args = ["debug", "replay", session, "--until", String(until), "--config-dir", app.configDir];
    const stdout = execFileSync(sok, args, { encoding: "utf8", timeout: 60000 });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    if (typeof error.status !== "number") throw error;
    return { code: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a terminal session replays with the sidecar and page hashes equal`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START terminal replay`);
    const [{ surface }] = await ensureTerminals(s, 1);
    const { sessionId } = await s.until("terminal.session", (state) => Boolean(state.sessionId),
      `${surface} did not open a sidecar session`, { surface });
    const offsets = currentEventOffsets(app.configDir);
    await s.run("terminal.input", { bytes: "printf 'REPLAY-%s\\n' one two\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.includes("REPLAY-two"), `${surface} did not show the printed lines`);
    const until = await storedSequence(app, offsets, sessionId);
    const result = replay(app, sessionId, until);
    t.diagnostic(`${app.name}: replay ${JSON.stringify(result)}`);
    assert.equal(result.code, 0, `sok debug replay failed: ${result.stderr}`);
    const match = /^replay session \S+: (\d+) sidecar frames and (\d+) page frames equal in (\d+) segments\n$/.exec(result.stdout);
    assert.ok(match, `unexpected replay output: ${JSON.stringify(result.stdout)}`);
    const [, sidecarFrames, pageFrames] = match.map(Number);
    assert.ok(sidecarFrames >= 2, `the replay compared ${sidecarFrames} sidecar frames`);
    assert.ok(pageFrames >= 2, `the replay compared ${pageFrames} page frames`);
    t.diagnostic(`${app.name}: PASS terminal replay`);
  });

  test(`${app.name}: a screen message changed on the way is a divergence of the layer plugin`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START terminal replay divergence`);
    const [{ surface }] = await ensureTerminals(s, 1);
    const { sessionId } = await s.until("terminal.session", (state) => Boolean(state.sessionId),
      `${surface} did not open a sidecar session`, { surface });
    const offsets = currentEventOffsets(app.configDir);
    await s.run("terminal.screen.alter", {}, surface);
    await s.run("terminal.input", { bytes: "printf 'ALTERED-%s\\n' one two\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.includes("ALTERED-two"), `${surface} did not show the printed lines`);
    const until = await storedSequence(app, offsets, sessionId);
    const result = replay(app, sessionId, until);
    t.diagnostic(`${app.name}: replay ${JSON.stringify(result)}`);
    assert.equal(result.code, 1, `sok debug replay did not report the changed message: ${JSON.stringify(result)}`);
    const pattern = new RegExp(`^sok: replay divergence: session ${sessionId} segment \\S+ sequence \\d+ layer plugin expected [0-9a-f]{64} found [0-9a-f]{64}\\n$`);
    assert.match(result.stderr, pattern);
    t.diagnostic(`${app.name}: PASS terminal replay divergence`);
  });
}
