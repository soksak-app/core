// A key typed into a terminal leaves a record in every layer of the input path, with the typed text and the time
// (docs/spec/diagnostics.md#rules). The check types through the native input of the endpoint, then reads the records that the
// typing appended to the event log of the application.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { eventLine, currentEventOffsets, readEvents, traceRows, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

// The text of the bytes that a pty_read line of the terminal sidecar holds as hex; the event stores no text copy of the bytes
// (docs/spec/replay.md#records). The line is `<level> <layer> <event>: <fields>`.
function readText(line) {
  const { hex } = JSON.parse(line.slice(line.indexOf(": ") + 2));
  return Buffer.from(hex, "hex").toString("latin1");
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

    const eventOffsets = currentEventOffsets(s.app.configDir);
    // Enter does not pass through the input method, so it reaches the sidecar in an application that is not active.
    await s.key("Enter", "down");
    await s.key("Enter", "up");
    await readScreenUntil(s, terminal.surface, (lines) => lines.filter((line) => line.startsWith("sh-")).length >= 2,
      "the shell did not print a second prompt after Enter");

    // The native library stores its records in the ring of the process, the writer of the host pulls them at its next batch,
    // and the flush waits until they are in the event log.
    await s.flushLog();
    // The sidecar writes its own event file in batches, so the check waits until the read of the prompt after Enter is in it.
    await untilEventLine(s.app.configDir, eventOffsets, (text) => text.includes("sidecar.vt.pty_read") && readText(text).includes("sh-"), 10000);
    const events = readEvents(s.app.configDir, eventOffsets).events;
    const log = events.map((event) => ({ text: eventLine(event), ts: new Date(event.ts_us / 1000).toISOString() }));
    // The trace of the page and of the host is in the event log.
    // The terminal plugin stores the steps of its input path as plugin events `plugin.terminal.<event>` (docs/spec/plugins.md#logging),
    // which are rows of the layer plugin beside the rows of the performance trace.
    const prefix = "plugin.terminal.";
    const pluginRows = events.filter((event) => event.event.startsWith(prefix)).map((event) => ({
      layer: "plugin", event: event.event.slice(prefix.length), ts: new Date(event.ts_us / 1000).toISOString(),
      ...(event.cids === undefined ? {} : { cids: event.cids }), ...event.fields,
    }));
    const trace = [...traceRows(events), ...pluginRows];
    // Each layer must hold the key with its own fields; `find` names the record that the layer lacks.
    const nativeLine = (pattern) => log.find((line) => pattern.test(line.text));
    const traced = (match) => trace.find(match);
    // An event of the input chain: the typed event with its time, so the hops compare with the other records.
    const typed = (match) => {
      const event = events.find(match);
      return event && { ts: new Date(event.ts_us / 1000).toISOString(), event };
    };
    const forEnter = (record) => record.surface === terminal.surface;
    const found = {
      injected: nativeLine(/^info native input inject: \{"kind":"key","key":"Enter".*"down":true.*"result":"delivered".*"responder":"SPImageRegion"/),
      nativeKeyDown: typed((e) => e.event === "native.input.key_down" && e.fields.keyCode === 36),
      nativeReport: typed((e) => e.event === "native.input.report" && e.fields.report.startsWith('{"type":"key","key":"Enter"')),
      hostRegion: traced((r) => r.layer === "host" && r.event === "region" && forEnter(r) && r.body?.key === "Enter"),
      pageRegion: traced((r) => r.layer === "plugin" && r.event === "region" && forEnter(r) && r.key === "Enter"),
      pageIme: traced((r) => r.layer === "plugin" && r.event === "ime" && forEnter(r) && r.key === "Enter"),
      pageInput: traced((r) => r.layer === "plugin" && r.event === "input" && forEnter(r) && r.key === "Enter"),
      pageSend: traced((r) => r.layer === "plugin" && r.event === "send" && forEnter(r) && r.body?.keys?.[0]?.key === "Enter"),
      pageSendResult: traced((r) => r.layer === "plugin" && r.event === "send.result" && r.operation === "input" && r.ok === true),
      hostSidecarSend: traced((r) => r.layer === "host" && r.event === "sidecar.send" && forEnter(r) && r.body?.keys?.[0]?.key === "Enter"),
      vtRequest: traced((r) => r.layer === "vt-core" && r.event === "request" && r.operation === "input" && forEnter(r)
        && r.body?.body?.keys?.[0]?.key === "Enter"),
      ptyWrite: traced((r) => r.layer === "vt-core" && r.event === "pty_write" && r.hex === "0d"),
      ptyRead: traced((r) => r.layer === "vt-core" && r.event === "pty_read" && Buffer.from(r.hex, "hex").toString("latin1").includes("sh-")),
    };
    const missing = Object.entries(found).filter(([, record]) => !record).map(([name]) => name);
    assert.deepEqual(missing, [], `${app.name}: the typed Enter left no record in: ${missing.join(", ")}`);
    // The identifier that the native layer assigned to the key is carried by every hop of the chain of the input
    // (docs/spec/logging.md#correlation-identifier): the report, the relay of the host, the call of the page that sends the
    // request, and the request of the host to the sidecar.
    const [cid] = found.nativeKeyDown.event.cids ?? [];
    assert.ok(cid, `${app.name}: native.input.key_down has no cids`);
    const hops = {
      nativeReport: found.nativeReport.event,
      hostRelay: events.find((e) => e.event === "host.input.relay" && e.cids?.includes(cid)),
      pageCall: events.find((e) => e.event === "page.call" && e.fields.name === "sidecarSend" && e.cids?.includes(cid)),
      hostRequest: events.find((e) => e.event === "host.sidecar.request" && e.cids?.includes(cid)),
    };
    const unlinked = Object.entries(hops).filter(([, hop]) => !hop?.cids?.includes(cid)).map(([name]) => name);
    assert.deepEqual(unlinked, [], `${app.name}: the hops ${unlinked.join(", ")} do not carry ${cid}`);
    // The page takes its clocks from the host with an error of at most half the round trip of its anchor, which the page states as
    // page.log.clock in the main event file of the host (docs/spec/logging.md#writers); an order between a record of the page and a
    // record of another process holds within that bound.
    const { pid } = JSON.parse(readFileSync(join(s.app.configDir, "endpoint.json"), "utf8"));
    const main = readdirSync(join(s.app.configDir, "logs")).find((name) => /^host-\d+-\d+\.jsonl$/.test(name) && name.endsWith(`-${pid}.jsonl`));
    const anchor = readFileSync(join(s.app.configDir, "logs", main), "utf8").split("\n").filter((line) => line.includes('"page.log.clock"')).at(-1);
    assert.ok(anchor, `${app.name}: ${main} holds no page.log.clock`);
    const halfTripUs = JSON.parse(anchor).fields.trip_us / 2;
    const onPageClock = new Set(["page.call", "pageRegion", "pageSend"]);
    const bound = (left, right) => (onPageClock.has(left) !== onPageClock.has(right) ? halfTripUs : 0);
    // The delay between the layers is measured on the monotonic clock, which the layers of one boot share.
    const clock = [["native.input.key_down", found.nativeKeyDown.event], ["native.input.report", hops.nativeReport], ["host.input.relay", hops.hostRelay],
      ["page.call", hops.pageCall], ["host.sidecar.request", hops.hostRequest]];
    for (let index = 1; index < clock.length; index++) {
      const [, earlier] = clock[index - 1];
      const [name, later] = clock[index];
      const slack = bound(clock[index - 1][0], name) * 1000;
      assert.ok(Number.isInteger(later.mono_ns) && later.mono_ns + slack >= earlier.mono_ns,
        `${app.name}: ${name} (mono_ns ${later.mono_ns}) is before ${clock[index - 1][0]} (mono_ns ${earlier.mono_ns}) by more than the anchor bound ${slack} ns`);
      t.diagnostic(`${app.name}: ${clock[index - 1][0]} -> ${name}: ${(later.mono_ns - earlier.mono_ns) / 1000} us`);
    }
    // The layers record the key in the order in which it travels; a time is written to the millisecond, so a comparison across the
    // clocks of the page and of the host allows the anchor bound rounded up to a millisecond, and one more for the rounding.
    const at = (record) => Date.parse(record.ts);
    // The injection record is written after the delivery, so it is not part of the order of the hops that the delivery causes.
    const order = ["nativeKeyDown", "nativeReport", "hostRegion", "pageRegion", "pageSend", "hostSidecarSend",
      "vtRequest", "ptyWrite", "ptyRead"];
    for (let index = 1; index < order.length; index++) {
      const earlier = at(found[order[index - 1]]);
      const later = at(found[order[index]]);
      const slack = bound(order[index - 1], order[index]) === 0 ? 0 : Math.ceil(halfTripUs / 1000) + 1;
      assert.ok(earlier <= later + slack,
        `${app.name}: ${order[index - 1]} (${found[order[index - 1]].ts}) is recorded after ${order[index]} (${found[order[index]].ts}) by more than ${slack} ms`);
    }
  });
}
