// Checks that a terminal session replays from the event log of the application with every stored hash equal
// (docs/spec/replay.md#command): the sidecar frame records and the page frame records that the terminal plugin stores for each
// screen message it receives. A message changed between the sidecar and the page, which the diagnostic command
// `terminal.screen.alter` of the terminal plugin injects, is reported as a divergence of the layer `plugin`. The check runs
// `sok debug replay` of the application bundle, so each host checks its own tool.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// Runs `sok debug replay` of the bundle on the configuration directory `config` (that of the application unless given) and returns
// its exit status, standard output and standard error.
function replay(app, session, until, config = app.configDir) {
  const sok = join(dirname(app.binary), "sok");
  try {
    const args = ["debug", "replay", session, "--until", String(until), "--config-dir", config];
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
    // The replay stores the divergence that this check causes as an error event of the tool in the configuration folder.
    s.expectError(new RegExp(`sok\\.replay\\.divergence: .*"layer":"plugin".*"session":"${sessionId}"`));
    const result = replay(app, sessionId, until);
    t.diagnostic(`${app.name}: replay ${JSON.stringify(result)}`);
    assert.equal(result.code, 1, `sok debug replay did not report the changed message: ${JSON.stringify(result)}`);
    const pattern = new RegExp(`^sok: replay divergence: session ${sessionId} segment \\S+ sequence \\d+ layer plugin expected [0-9a-f]{64} found [0-9a-f]{64}\\n$`);
    assert.match(result.stderr, pattern);
    t.diagnostic(`${app.name}: PASS terminal replay divergence`);
  });

  test(`${app.name}: a session with output, a resize, a scroll, a selection, a theme and input replays with every hash equal`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START terminal replay of the view state`);
    const { mode } = (await s.get("core.settings")).values;
    s.cleanup(async () => {
      await s.run("core.settings.set", { patch: { mode } });
      await s.until("core.settings", (value) => value.values.mode === mode && !value.saving, "the theme was not restored");
    });
    const [{ surface }] = await ensureTerminals(s, 1);
    const { sessionId, cols } = await s.until("terminal.session", (state) => Boolean(state.sessionId),
      `${surface} did not open a sidecar session`, { surface });
    const offsets = currentEventOffsets(app.configDir);
    await s.run("terminal.input", { bytes: "seq 1 60\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.includes("60"), `${surface} did not show the output`);
    await s.run("terminal.scrollback.set", { offset: 5 }, surface);
    await s.until("terminal.session", (state) => state.scrollback?.offset === 5, "the viewport did not move", { surface });
    await s.run("terminal.scrollback.set", { offset: 0 }, surface);
    await s.until("terminal.session", (state) => state.scrollback?.offset === 0, "the viewport did not return", { surface });
    // A selection made by native pointer input over the output: the sidecar stores its start, update and end.
    const view = await s.rect("terminal.view", undefined, surface);
    const metrics = await s.get("terminal.session", surface);
    const released = metrics.selectionReleases;
    const y = view.document.y + view.y + 1.5 * metrics.cellHeight;
    const x = view.document.x + view.x;
    await s.pointer(x + 0.5 * metrics.cellWidth, y, "down", { button: "left" });
    await s.pointer(x + 6.5 * metrics.cellWidth, y, "drag", { button: "left" });
    await s.pointer(x + 6.5 * metrics.cellWidth, y, "up", { button: "left" });
    await s.until("terminal.session", (value) => value?.selectionReleases > released || value?.error !== undefined,
      "the sidecar did not answer the selection release", { surface });
    const other = mode === "dark" ? "light" : "dark";
    await s.run("core.settings.set", { patch: { mode: other } });
    await s.until("core.settings", (value) => value.values.mode === other && !value.saving, "the theme did not change");
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    await s.run("core.card.split", { card: card.id, side: "right", plugin: "terminal" });
    await s.until("terminal.session", (state) => state.cols !== cols, "the terminal was not resized", { surface });
    await s.run("terminal.input", { bytes: "printf 'VIEW-%s\\n' done\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.includes("VIEW-done"), `${surface} did not show the last line`);
    const until = await storedSequence(app, offsets, sessionId);
    const { events } = readEvents(app.configDir, offsets);
    const inputs = new Set(events.filter((event) => event.session === sessionId && event.fields?.sequence <= until)
      .map((event) => event.event));
    for (const name of ["sidecar.vt.pty_read", "sidecar.vt.pty_write", "sidecar.vt.resize", "sidecar.vt.viewport", "sidecar.vt.theme",
      "sidecar.vt.selection"]) {
      assert.ok(inputs.has(name), `the session stored no ${name} up to sequence ${until}: ${[...inputs]}`);
    }
    const result = replay(app, sessionId, until);
    t.diagnostic(`${app.name}: replay ${JSON.stringify(result)}`);
    assert.equal(result.code, 0, `sok debug replay failed: ${result.stderr}`);
    assert.match(result.stdout, /^replay session \S+: \d+ sidecar frames and \d+ page frames equal in \d+ segments\n$/);
    t.diagnostic(`${app.name}: PASS terminal replay of the view state`);
  });

  test(`${app.name}: a stored input that was changed is a divergence of the layer sidecar`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START terminal replay of a changed input`);
    const [{ surface }] = await ensureTerminals(s, 1);
    const { sessionId } = await s.until("terminal.session", (state) => Boolean(state.sessionId),
      `${surface} did not open a sidecar session`, { surface });
    const offsets = currentEventOffsets(app.configDir);
    await s.run("terminal.input", { bytes: "printf 'STORED-%s\\n' one two\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.includes("STORED-two"), `${surface} did not show the printed lines`);
    const until = await storedSequence(app, offsets, sessionId);
    // The replay reads a copy of the event files and of the installed sidecars in a disposable configuration directory, in which
    // one byte of the last output that the session read up to the sequence is changed; the files of the application stay as
    // they are.
    const copy = mkdtempSync(join(tmpdir(), "soksak-replay-"));
    s.cleanup(() => rmSync(copy, { recursive: true, force: true }));
    for (const name of readdirSync(join(app.configDir, "logs")).filter((entry) => entry.endsWith(".jsonl"))) {
      cpSync(join(app.configDir, "logs", name), join(copy, "logs", name));
    }
    cpSync(join(app.configDir, "plugins"), join(copy, "plugins"), { recursive: true });
    cpSync(join(app.configDir, "sidecars"), join(copy, "sidecars"), { recursive: true });
    let changed = null;
    for (const name of readdirSync(join(copy, "logs")).filter((entry) => /^vt-.*\.jsonl$/.test(entry))) {
      const path = join(copy, "logs", name);
      const lines = readFileSync(path, "utf8").split("\n");
      const index = lines.findLastIndex((line) => {
        if (!line.includes('"sidecar.vt.pty_read"')) return false;
        const event = JSON.parse(line);
        return event.session === sessionId && event.fields.sequence <= until && event.fields.hex.length >= 2;
      });
      if (index < 0) continue;
      const event = JSON.parse(lines[index]);
      const first = event.fields.hex.slice(0, 2);
      event.fields.hex = (first === "41" ? "42" : "41") + event.fields.hex.slice(2);
      lines[index] = JSON.stringify(event);
      writeFileSync(path, lines.join("\n"));
      changed = event.fields.sequence;
    }
    assert.ok(changed !== null, `no output of the session ${sessionId} up to sequence ${until} was stored`);
    const result = replay(app, sessionId, until, copy);
    t.diagnostic(`${app.name}: changed the output at sequence ${changed}; replay ${JSON.stringify(result)}`);
    assert.equal(result.code, 1, `sok debug replay did not report the changed input: ${JSON.stringify(result)}`);
    const pattern = new RegExp(`^sok: replay divergence: session ${sessionId} segment \\S+ sequence \\d+ layer sidecar expected [0-9a-f]{64} found [0-9a-f]{64}\\n$`);
    assert.match(result.stderr, pattern);
    t.diagnostic(`${app.name}: PASS terminal replay of a changed input`);
  });
}
