// A key typed into an image region leaves a record in every layer of the input path, with the typed text and the time
// (docs/spec/diagnostics.md#rules). The image region is that of the raster probe, whose sidecar records each request it receives
// and whose `rasterprobe.input` logs each input transaction with the echo of the sidecar. The check types through the native input
// of the endpoint, then reads the records that the typing appended to the event log of the application.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { eventLine, currentEventOffsets, readEvents, traceRows, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { fresh, reading } from "./fixture.mjs";
import { EVERY_LEVEL } from "@soksak/window-check/log-policy.mjs";
import { assertReceivedUnchanged, imageFocused, imagePoint, lastTransaction, rasterProbeTab, receivedAfter, typedText } from "./input-probe.mjs";

/** The records of the input path that the check reads, all below `error`. */
const READS = ["native.record.info", "native.input.key_down", "native.input.report", "host.trace.region", "host.trace.sidecar.send",
  "host.input.relay", "workbench.call", "workbench.log.clock", "host.sidecar.request", "sidecar.rasterprobe.request"];

for (const app of Object.values(APPS)) {
  test(`${app.name}: a typed key leaves a record in every layer of the input path`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { performanceTrace: true, log: EVERY_LEVEL, reads: READS });
    // The raster probe opens its sidecar session before it reports ready.
    const { surface } = await rasterProbeTab(s);
    const point = await imagePoint(s, surface);
    // A press makes the region the first responder, as the person's click does.
    await s.click(point.x, point.y);
    // The region takes the keyboard after the press has passed to the page, so the typing waits for the focus.
    await s.until("host.window", (state) => imageFocused(state, surface),
      `the image region ${surface} did not take the keyboard after the press`);
    const start = await lastTransaction(s, surface);

    const eventOffsets = currentEventOffsets(s.app.configDir);
    // Enter does not pass through the input method, so it reaches the sidecar in an application that is not active.
    await s.key("Enter", "down");
    await s.key("Enter", "up");
    await s.until("rasterprobe.input", (input) => typedText(input.log.filter((entry) => entry.sequence > start)) === "\n",
      "the image region did not report Enter", { surface });
    const transactions = await receivedAfter(s, surface, start, "the sidecar did not echo the input transaction of Enter");
    assertReceivedUnchanged(transactions, `${app.name} Enter`);

    // The native library stores its records in the ring of the process, the writer of the host pulls them at its next batch,
    // and the flush waits until they are in the event log.
    await s.flushLog();
    // The sidecar writes its own event file in batches, so the check waits until its record of the input request is in it.
    await untilEventLine(s.app.configDir, eventOffsets, (text) => text.includes("sidecar.rasterprobe.request")
      && text.includes('"operation":"input"'), 10000, reading(s.app, ["sidecar.rasterprobe.request"]));
    const events = readEvents(s.app.configDir, eventOffsets).events;
    const log = events.map((event) => ({ text: eventLine(event), ts: new Date(event.ts_us / 1000).toISOString() }));
    // The trace of the host is in the event log.
    const trace = traceRows(events);
    // Each layer must hold the key with its own fields; `find` names the record that the layer lacks.
    const nativeLine = (pattern) => log.find((line) => pattern.test(line.text));
    const traced = (match) => trace.find(match);
    // An event of the input chain: the typed event with its time, so the hops compare with the other records.
    const typed = (match) => {
      const event = events.find(match);
      return event && { ts: new Date(event.ts_us / 1000).toISOString(), event };
    };
    const forEnter = (record) => record.surface === surface;
    // The input path carries the typed key as an action of the input report (docs/spec/native-surfaces.md).
    const enter = (actions) => Array.isArray(actions) && actions.some((action) => action.type === "key" && action.key === "Enter");
    const found = {
      injected: nativeLine(/^info native input inject: \{"kind":"key","key":"Enter".*"down":true.*"result":"delivered".*"responder":"SPImageRegion"/),
      nativeKeyDown: typed((e) => e.event === "native.input.key_down" && e.fields.keyCode === 36),
      nativeReport: typed((e) => e.event === "native.input.report" && enter(JSON.parse(e.fields.report).actions)),
      hostRegion: traced((r) => r.layer === "host" && r.event === "region" && forEnter(r) && enter(r.body?.actions)),
      hostSidecarSend: traced((r) => r.layer === "host" && r.event === "sidecar.send" && forEnter(r) && enter(r.body?.actions)),
    };
    const missing = Object.entries(found).filter(([, record]) => !record).map(([name]) => name);
    assert.deepEqual(missing, [], `${app.name}: the typed Enter left no record in: ${missing.join(", ")}`);
    // The identifier that the native layer assigned to the key is carried by every hop of the chain of the input
    // (docs/spec/logging.md#correlation-identifier): the report, the relay of the host, the call of the page that sends the
    // request, the request of the host to the sidecar, and the record of the sidecar that received it. The raster probe is a view,
    // so the page sends its request with the call viewSidecarSend that it makes for the view.
    const [cid] = found.nativeKeyDown.event.cids ?? [];
    assert.ok(cid, `${app.name}: native.input.key_down has no cids`);
    const hops = {
      nativeReport: found.nativeReport.event,
      hostRelay: events.find((e) => e.event === "host.input.relay" && e.cids?.includes(cid)),
      pageCall: events.find((e) => e.event === "workbench.call" && e.fields.name === "viewSidecarSend" && e.cids?.includes(cid)),
      hostRequest: events.find((e) => e.event === "host.sidecar.request" && e.cids?.includes(cid)),
      sidecarRequest: events.find((e) => e.event === "sidecar.rasterprobe.request" && e.fields.operation === "input" && forEnter(e)
        && e.cids?.includes(cid)),
    };
    const unlinked = Object.entries(hops).filter(([, hop]) => !hop?.cids?.includes(cid)).map(([name]) => name);
    assert.deepEqual(unlinked, [], `${app.name}: the hops ${unlinked.join(", ")} do not carry ${cid}`);
    // The workbench takes its clocks from the host with an error of at most half the round trip of its anchor plus its clock
    // resolution, which each workbench start states as workbench.log.clock (docs/spec/logging.md#writers). Every workbench event
    // names the start that wrote it, so the anchor of workbench.call is the last workbench.log.clock of the same start before it.
    const { pid } = JSON.parse(readFileSync(join(s.app.configDir, "endpoint.json"), "utf8"));
    const main = readdirSync(join(s.app.configDir, "logs")).find((name) => /^host-\d+-\d+\.jsonl$/.test(name) && name.endsWith(`-${pid}.jsonl`));
    assert.ok(hops.pageCall.start, `${app.name}: workbench.call names no start`);
    const anchor = readFileSync(join(s.app.configDir, "logs", main), "utf8").split("\n")
      .filter((line) => line.includes('"workbench.log.clock"')).map((line) => JSON.parse(line))
      .filter((e) => e.start === hops.pageCall.start && e.mono_ns <= hops.pageCall.mono_ns).at(-1);
    assert.ok(anchor, `${app.name}: ${main} holds no workbench.log.clock of the start ${hops.pageCall.start} before workbench.call`);
    const { trip_us: tripUs, resolution_us: resolutionUs } = anchor.fields;
    const halfTripUs = tripUs / 2 + resolutionUs;
    const onPageClock = new Set(["workbench.call start", "workbench.call"]);
    // workbench.call is written when the call ends, and its micros is measured on the page clock, so its start, the end less micros,
    // carries one more resolution of the page clock than the end.
    const bound = (left, right) => (onPageClock.has(left) === onPageClock.has(right) ? 0
      : [left, right].includes("workbench.call start") ? halfTripUs + resolutionUs : halfTripUs);
    const callStart = { ...hops.pageCall, mono_ns: hops.pageCall.mono_ns - hops.pageCall.fields.micros * 1000 };
    // The delay between the layers is measured on the monotonic clock, which the layers of one boot share. The host receives the
    // send between the start and the end of the call of the page.
    const clock = [["native.input.key_down", found.nativeKeyDown.event], ["native.input.report", hops.nativeReport], ["host.input.relay", hops.hostRelay],
      ["workbench.call start", callStart], ["host.sidecar.request", hops.hostRequest], ["workbench.call", hops.pageCall]];
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
    found.sidecarRequest = { ts: new Date(hops.sidecarRequest.ts_us / 1000).toISOString(), event: hops.sidecarRequest };
    const order = ["nativeKeyDown", "nativeReport", "hostRegion", "hostSidecarSend", "sidecarRequest"];
    for (let index = 1; index < order.length; index++) {
      const earlier = at(found[order[index - 1]]);
      const later = at(found[order[index]]);
      const slack = bound(order[index - 1], order[index]) === 0 ? 0 : Math.ceil(halfTripUs / 1000) + 1;
      assert.ok(earlier <= later + slack,
        `${app.name}: ${order[index - 1]} (${found[order[index - 1]].ts}) is recorded after ${order[index]} (${found[order[index]].ts}) by more than ${slack} ms`);
    }
  });
}
