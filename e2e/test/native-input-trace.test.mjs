// Checks the delivery check of the composition checks (e2e/native-input-trace.mjs) on records in the form that core writes:
// `native.input.report` of the native library with the JSON report of an input transaction, `host.sidecar.request` of the host, and
// the input log of the raster probe.
import assert from "node:assert/strict";
import test from "node:test";

import { assertNativeInputDelivered, nativeInputTransactions } from "../native-input-trace.mjs";

const SURFACE = "tab-1";
const SIDECAR = "@sok-check/sidecar-rasterprobe";
const preedit = (text) => ({ text, markedRange: text ? { location: 0, length: text.length } : null,
  selectedRange: { location: text.length, length: 0 }, replacementRange: null, attributed: false });

/** The record of a native input transaction, as image_region.m writes it. */
function report(mono, cid, actions, text, { errors = [], dropped = false, recorded = [cid] } = {}) {
  const body = { type: "input", actions, preedit: preedit(text), errors, cids: [cid] };
  return { event: "native.input.report", mono_ns: mono, cids: recorded, fields: { report: JSON.stringify(body), dropped } };
}

const request = (mono, cid, { surface = SURFACE, name = SIDECAR } = {}) =>
  ({ event: "host.sidecar.request", mono_ns: mono, cids: [cid], fields: { name, surface, bytes: 90 } });

/** The input log entry of the raster probe for a transaction that its sidecar answered under the same identifiers. */
function entry(sequence, cid, actions, text) {
  return { sequence, cids: [cid], actions, preedit: preedit(text), errors: [],
    received: { operation: "input", sequence, actions, preedit: preedit(text) }, receivedCids: [cid], frame: null };
}

const insert = (text) => ({ type: "insert", text, replacementRange: null, attributed: false });
const key = (name) => ({ type: "key", key: name, shift: false, alt: false, ctrl: false });

function delivered() {
  const events = [
    report(100, "b.1", [{ type: "focus", focused: true }], ""),
    request(110, "b.1"),
    report(200, "b.2", [], "ㅎ"),
    { event: "native.input.report", mono_ns: 201, cids: ["b.2"], fields: { report: JSON.stringify({ type: "focus", focused: true, cids: ["b.2"] }), dropped: false } },
    request(210, "b.2"),
    report(300, "b.3", [insert("하"), key("Enter")], ""),
    request(310, "b.3"),
  ];
  const log = [entry(4, "b.1", [{ type: "focus", focused: true }], ""), entry(5, "b.2", [], "ㅎ"), entry(6, "b.3", [insert("하"), key("Enter")], "")];
  return { events, log };
}

test("each native input transaction after the start reached the sidecar unchanged under its identifiers", { timeout: 5000 }, () => {
  const { events, log } = delivered();
  const matched = assertNativeInputDelivered(events, log, SURFACE, 4, "ime");
  assert.deepEqual(matched.map(({ entry: item, native }) => [item.sequence, native.cids[0]]), [[5, "b.2"], [6, "b.3"]]);
  assert.deepEqual(nativeInputTransactions(events).map(({ cids }) => cids[0]), ["b.1", "b.2", "b.3"], "only input reports are transactions");
});

test("a changed transaction, a missing request, a reordered request and an unanswered transaction fail", { timeout: 5000 }, () => {
  const changed = delivered();
  changed.log[1] = { ...changed.log[1], actions: [insert("ㅎ")] };
  assert.throws(() => assertNativeInputDelivered(changed.events, changed.log, SURFACE, 4, "ime"), /input transaction 5 \(b\.2\) changed its actions/);

  const received = delivered();
  received.log[2] = { ...received.log[2], received: { ...received.log[2].received, preedit: preedit("x") } };
  assert.throws(() => assertNativeInputDelivered(received.events, received.log, SURFACE, 4, "ime"), /did not reach the sidecar unchanged/);

  const answered = delivered();
  answered.log[2] = { ...answered.log[2], receivedCids: ["b.9"] };
  assert.throws(() => assertNativeInputDelivered(answered.events, answered.log, SURFACE, 4, "ime"), /answered under other correlation identifiers/);

  const missing = delivered();
  missing.events = missing.events.filter((event) => !(event.event === "host.sidecar.request" && event.cids[0] === "b.3"));
  assert.throws(() => assertNativeInputDelivered(missing.events, missing.log, SURFACE, 4, "ime"), /has 0 host requests of the sidecar/);

  const other = delivered();
  other.events = other.events.map((event) => (event.event === "host.sidecar.request" && event.cids[0] === "b.3" ? request(310, "b.3", { surface: "tab-2" }) : event));
  assert.throws(() => assertNativeInputDelivered(other.events, other.log, SURFACE, 4, "ime"), /has 0 host requests of the sidecar/);

  const early = delivered();
  early.events = early.events.map((event) => (event.event === "host.sidecar.request" && event.cids[0] === "b.2" ? request(150, "b.2") : event));
  assert.throws(() => assertNativeInputDelivered(early.events, early.log, SURFACE, 4, "ime"), /the sidecar request preceded its native report/);
});

test("the native records and the input log must match one to one, and a check without input fails", { timeout: 5000 }, () => {
  const extra = delivered();
  extra.log.push(entry(7, "b.4", [insert("a")], ""));
  assert.throws(() => assertNativeInputDelivered(extra.events, extra.log, SURFACE, 4, "ime"), /do not match the input log one to one/);

  const unknown = delivered();
  unknown.events.push(report(400, "b.5", [insert("a")], ""), request(410, "b.5"));
  assert.throws(() => assertNativeInputDelivered(unknown.events, unknown.log, SURFACE, 4, "ime"), /the input log holds 0 transactions of native input b\.5/);

  const none = delivered();
  assert.throws(() => assertNativeInputDelivered(none.events, none.log, SURFACE, 6, "ime"), /reported no input transaction/);
});

test("a native transaction must be complete, sent, error free and recorded under the identifiers of its report", { timeout: 5000 }, () => {
  assert.throws(() => nativeInputTransactions([report(1, "b.1", [], "", { errors: [{ reason: "range outside the marked text" }] })]),
    /native input transaction b\.1 failed: range outside the marked text/);
  assert.throws(() => nativeInputTransactions([report(1, "b.1", [], "", { dropped: true })]), /native input transaction b\.1 was dropped/);
  assert.throws(() => nativeInputTransactions([report(1, "b.1", [], "", { recorded: ["b.2"] })]), /recorded with other identifiers/);
  assert.throws(() => nativeInputTransactions([report(1, "b.1", [{ type: "insert", text: "a" }], "")]), /actions\[0\] has missing or unexpected fields/);
  assert.throws(() => nativeInputTransactions([report(1, "b.1", [{ type: "paste" }], "")]), /actions\[0\]\.type is unsupported/);
  const outside = report(1, "b.1", [], "ab");
  const body = JSON.parse(outside.fields.report);
  body.preedit.markedRange = { location: 1, length: 2 };
  outside.fields.report = JSON.stringify(body);
  assert.throws(() => nativeInputTransactions([outside]), /markedRange exceeds the UTF-16 text bounds/);
  const twoCids = report(1, "b.1", [], "");
  twoCids.fields.report = JSON.stringify({ ...JSON.parse(twoCids.fields.report), cids: ["b.1", "b.2"] });
  assert.throws(() => nativeInputTransactions([twoCids]), /must hold exactly one nonempty correlation identifier/);
});
