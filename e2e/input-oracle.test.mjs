// The input oracle (docs/spec/diagnostics.md#rules): the bytes that the sidecar logs as written to the PTY are the bytes that an
// independent receiver, a process in the terminal that reads its standard input, captured. The keys do not pass through the input
// method, so they reach the sidecar in an application that is not active.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { fresh, reading } from "./fixture.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

// Tab, Escape, Backspace, Enter and Control+A, with the bytes of each on the PTY.
const KEYS = [["Tab", {}], ["Escape", {}], ["Backspace", {}], ["Enter", {}], ["a", { modifiers: ["control"] }]];
const EXPECTED = "091b7f0d01";

// The text of the bytes that a pty_read line of the terminal sidecar holds as hex; the event stores no text copy of the bytes
// (docs/spec/replay.md#records). The line is `<level> <layer> <event>: <fields>`.
/** The records that the check reads, below `error`. */
const READS = ["sidecar.vt.pty_read", "sidecar.vt.pty_write"];

function readText(line) {
  const { hex } = JSON.parse(line.slice(line.indexOf(": ") + 2));
  return Buffer.from(hex, "hex").toString("latin1");
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the bytes logged as written to the PTY are the bytes that an independent receiver read`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    // The reads of the PTY are stored in the class io at the level debug.
    await fresh(s, { performanceTrace: true, log: { io: "debug" }, reads: READS });
    const [terminal] = await ensureTerminals(s, 1);
    await s.until("terminal.session", (state) => Boolean(state.sessionId),
      `${terminal.surface} did not open a sidecar session`, { surface: terminal.surface });
    await readScreenUntil(s, terminal.surface, (lines) => lines.some((line) => line.length > 0), "the shell printed nothing");
    const before = currentEventOffsets(s.app.configDir);
    const captured = join(s.app.configDir, "oracle.hex");
    // The receiver reads exactly the bytes of the keys in raw mode and prints them in hexadecimal; the quotes inside the markers keep
    // the echo of the command from being taken for the output.
    await s.run("terminal.input", {
      bytes: `stty raw -echo; echo REA''DY; od -An -v -tx1 -N${EXPECTED.length / 2} > '${captured}'; stty sane; echo DO''NE\r`,
    }, terminal.surface);
    await readScreenUntil(s, terminal.surface, (lines) => lines.some((line) => line.trim() === "READY"), "the receiver did not start");
    // The sidecar writes its event file in batches: once the read of READY is in it, the writes of the command are in it too, so the
    // offsets taken now start after them.
    await untilEventLine(s.app.configDir, before, (text) => text.includes("sidecar.vt.pty_read") && readText(text).includes("READY"), 10000,
      reading(s.app, ["sidecar.vt.pty_read"]));
    const host = await s.get("host.window");
    const region = host.regions.find((item) => item.surface === terminal.surface && item.name === "view");
    assert.ok(region?.frame, `native terminal region ${terminal.surface} has no frame`);
    await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height / 2);
    await s.until("host.window", (state) => state.regions.some((item) =>
      item.surface === terminal.surface && item.name === "view" && item.focused),
    `the terminal region ${terminal.surface} did not take the keyboard after the press`);
    const offsets = currentEventOffsets(s.app.configDir);
    for (const [key, options] of KEYS) await s.press(key, options);
    await readScreenUntil(s, terminal.surface, (lines) => lines.some((line) => line.trim() === "DONE"), "the receiver did not read the keys");
    await s.flushLog();
    await untilEventLine(s.app.configDir, offsets, (text) => text.includes("sidecar.vt.pty_read") && readText(text).includes("DONE"), 10000,
      reading(s.app, ["sidecar.vt.pty_read"]));
    const received = readFileSync(captured, "utf8").replace(/\s+/g, "");
    assert.equal(received, EXPECTED, `${app.name}: the receiver read other bytes than the keys give`);
    const logged = traceRows(readEvents(s.app.configDir, offsets).events)
      .filter((row) => row.layer === "vt-core" && row.event === "pty_write").map((row) => row.hex).join("");
    assert.equal(logged, received, `${app.name}: the bytes logged as written to the PTY differ from the bytes the receiver read`);
  });
}
