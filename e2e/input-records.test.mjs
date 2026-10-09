// A key typed into a terminal leaves a record in every layer of the input path, with the typed text and the time
// (docs/spec/diagnostics.md#rules). The check types through the native input of the endpoint, then reads the records that the
// typing appended to the application log and the performance trace of the application.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

/** The size of a file, or 0 when it does not exist yet. */
const sizeOf = (path) => (existsSync(path) ? statSync(path).size : 0);

/** The text that a file gained after `offset` bytes. */
function readFrom(path, offset) {
  return existsSync(path) ? readFileSync(path).subarray(offset).toString("utf8") : "";
}

/** The records of the performance trace that the typing appended, as objects. */
function traceRecords(text) {
  return text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a typed key leaves a record in every layer of the input path`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s, { performanceTrace: true });
    const [terminal] = await ensureTerminals(s, 1);
    await s.until("terminal.session", (state) => Boolean(state.sessionId),
      `${terminal.surface} did not open a sidecar session`, { surface: terminal.surface });
    // The shell prints its prompt before it takes input.
    await readScreenUntil(s, terminal.surface, (lines) => lines.some((line) => line.length > 0),
      "the shell printed nothing");
    const host = await s.get("host.window");
    const region = host.regions.find((item) => item.surface === terminal.surface && item.name === "view");
    assert.ok(region?.frame, `native terminal region ${terminal.surface} has no frame`);
    // A press makes the region the first responder, as the person's click does.
    await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height / 2);
    // The region takes the keyboard after the press has passed to the page, so the typing waits for the focus.
    await s.until("host.window", (state) => state.regions.some((item) =>
      item.surface === terminal.surface && item.name === "view" && item.focused),
    `the terminal region ${terminal.surface} did not take the keyboard after the press`);

    const logs = join(app.configDir, "logs");
    const logOffset = sizeOf(join(logs, "application.log"));
    const traceOffset = sizeOf(join(logs, "performance.ndjson"));
    // Enter does not pass through the input method, so it reaches the sidecar in an application that is not active.
    await s.key("Enter", "down");
    await s.key("Enter", "up");
    await readScreenUntil(s, terminal.surface, (lines) => lines.filter((line) => line.startsWith("sh-")).length >= 2,
      "the shell did not print a second prompt after Enter");

    const log = readFrom(join(logs, "application.log"), logOffset).split("\n");
    const trace = traceRecords(readFrom(join(logs, "performance.ndjson"), traceOffset));
    // Each layer must hold the key with its own fields; `find` names the record that the layer lacks.
    const nativeLine = (pattern) => log.find((line) => pattern.test(line));
    const traced = (match) => trace.find(match);
    const forEnter = (record) => record.surface === terminal.surface;
    const found = {
      injected: nativeLine(/ info native input inject: \{"kind":"key","key":"Enter".*"down":true.*"result":"delivered".*"responder":"SPImageRegion"/),
      nativeKeyDown: nativeLine(/ info native input method: \{"call":"keyDown","keyCode":36,/),
      nativeReport: nativeLine(/ info native input report: \{"type":"key","key":"Enter"/),
      hostRegion: traced((r) => r.layer === "host" && r.event === "region" && forEnter(r) && r.body?.key === "Enter"),
      pageRegion: traced((r) => r.layer === "page" && r.event === "region" && forEnter(r) && r.key === "Enter"),
      pageIme: traced((r) => r.layer === "page" && r.event === "ime" && forEnter(r) && r.key === "Enter"),
      pageInput: traced((r) => r.layer === "page" && r.event === "input" && forEnter(r) && r.key === "Enter"),
      pageSend: traced((r) => r.layer === "page" && r.event === "send" && forEnter(r) && r.body?.keys?.[0]?.key === "Enter"),
      pageSendResult: traced((r) => r.layer === "page" && r.event === "send.result" && r.operation === "input" && r.ok === true),
      hostSidecarSend: traced((r) => r.layer === "host" && r.event === "sidecar.send" && forEnter(r) && r.body?.keys?.[0]?.key === "Enter"),
      vtRequest: traced((r) => r.layer === "vt-core" && r.event === "request" && r.operation === "input" && forEnter(r)
        && r.body?.body?.keys?.[0]?.key === "Enter"),
      ptyWrite: traced((r) => r.layer === "vt-core" && r.event === "pty_write" && r.hex === "0d" && r.text === "\r"),
      ptyRead: traced((r) => r.layer === "vt-core" && r.event === "pty_read" && r.text.includes("sh-")),
    };
    const missing = Object.entries(found).filter(([, record]) => !record).map(([name]) => name);
    assert.deepEqual(missing, [], `${app.name}: the typed Enter left no record in: ${missing.join(", ")}`);
    // The layers record the key in the order in which it travels.
    const at = (record) => (typeof record === "string" ? record.slice(0, 24) : record.ts);
    // The injection record is written after the delivery, so it is not part of the order of the hops that the delivery causes.
    const order = ["nativeKeyDown", "nativeReport", "hostRegion", "pageRegion", "pageSend", "hostSidecarSend",
      "vtRequest", "ptyWrite", "ptyRead"];
    for (let index = 1; index < order.length; index++) {
      const earlier = at(found[order[index - 1]]);
      const later = at(found[order[index]]);
      assert.ok(earlier <= later, `${app.name}: ${order[index - 1]} (${earlier}) is recorded after ${order[index]} (${later})`);
    }
  });
}
