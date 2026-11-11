// The delivery of the native input transactions of an image region to its sidecar, as the event log records it, for the composition
// checks. The native library records each report of a region to the page as `native.input.report` with the identifier
// of its input (docs/spec/logging.md#correlation-identifier); an input transaction is the report of type `input` with its actions,
// its final preedit, its callback errors and its `cids` (docs/spec/native-surfaces.md#image-regions). The host records each request
// that it queued for a sidecar with the identifiers of the request line as `host.sidecar.request`. The image region is that of the
// raster probe, whose `rasterprobe.input` logs each transaction with the body and the identifiers of the answer of its sidecar.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { RASTER_SIDECAR } from "./raster-probe.mjs";

/** The records below error that a check of the delivery reads, and the log policy that stores them. */
export const NATIVE_INPUT_READS = Object.freeze(["native.input.report", "host.sidecar.request"]);
export const NATIVE_INPUT_LOG = Object.freeze({ input: "info", io: "info" });

function exactObject(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or unexpected fields`);
}

function strictRange(value, label) {
  if (value === null) return null;
  exactObject(value, ["location", "length"], label);
  assert.ok(Number.isSafeInteger(value.location) && value.location >= 0, `${label}.location is invalid`);
  assert.ok(Number.isSafeInteger(value.length) && value.length >= 0, `${label}.length is invalid`);
  assert.ok(Number.isSafeInteger(value.location + value.length), `${label} exceeds the safe integer range`);
  return value;
}

/** The final preedit of a transaction: the pending text with its marked, selected and replacement ranges in UTF-16 units. */
function strictPreedit(value, label) {
  exactObject(value, ["text", "markedRange", "selectedRange", "replacementRange", "attributed"], label);
  assert.equal(typeof value.text, "string", `${label}.text must be text`);
  assert.equal(typeof value.attributed, "boolean", `${label}.attributed must be boolean`);
  for (const key of ["markedRange", "selectedRange", "replacementRange"]) strictRange(value[key], `${label}.${key}`);
  for (const key of ["markedRange", "selectedRange"]) {
    const range = value[key];
    if (range !== null) assert.ok(range.location + range.length <= value.text.length, `${label}.${key} exceeds the UTF-16 text bounds`);
  }
  return value;
}

/** One action of a transaction: a committed insert, a key, a command or a focus change, each with exactly its fields. */
function strictAction(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  if (value.type === "insert") {
    exactObject(value, ["type", "text", "replacementRange", "attributed"], label);
    assert.equal(typeof value.text, "string", `${label}.text must be text`);
    strictRange(value.replacementRange, `${label}.replacementRange`);
    assert.equal(typeof value.attributed, "boolean", `${label}.attributed must be boolean`);
    return value;
  }
  if (value.type === "key") {
    assert.equal(typeof value.key, "string", `${label}.key must be text`);
    assert.ok(value.key.length > 0, `${label}.key must not be empty`);
    exactObject(value, value.key === "Char" ? ["type", "key", "text", "shift", "alt", "ctrl"] : ["type", "key", "shift", "alt", "ctrl"], label);
    if (value.key === "Char") assert.equal(typeof value.text, "string", `${label}.text must be text`);
    for (const modifier of ["shift", "alt", "ctrl"]) assert.equal(typeof value[modifier], "boolean", `${label}.${modifier} must be boolean`);
    return value;
  }
  if (value.type === "command") {
    exactObject(value, ["type", "selector"], label);
    assert.equal(typeof value.selector, "string", `${label}.selector must be text`);
    assert.ok(value.selector.length > 0, `${label}.selector must not be empty`);
    return value;
  }
  if (value.type === "focus") {
    exactObject(value, ["type", "focused"], label);
    assert.equal(typeof value.focused, "boolean", `${label}.focused must be boolean`);
    return value;
  }
  throw new Error(`${label}.type is unsupported: ${JSON.stringify(value.type)}`);
}

function strictCids(value, label) {
  assert.ok(Array.isArray(value) && value.length === 1 && typeof value[0] === "string" && value[0].length > 0,
    `${label} must hold exactly one nonempty correlation identifier`);
  return value;
}

/**
 * The native input transactions that `events` record, in order: each `native.input.report` whose report is of type `input`, with
 * its identifiers, actions, preedit and the monotonic time of the record. Every such report must be complete, sent (not dropped)
 * and free of callback errors, and its record must carry the identifiers that the report carries.
 */
export function nativeInputTransactions(events) {
  assert.ok(Array.isArray(events), "the native input records must be an array");
  const transactions = [];
  for (const [index, event] of events.entries()) {
    if (event?.event !== "native.input.report") continue;
    const label = `native.input.report ${index}`;
    assert.equal(typeof event.fields?.report, "string", `${label} has no report text`);
    const report = JSON.parse(event.fields.report);
    if (report?.type !== "input") continue;
    exactObject(report, ["type", "actions", "preedit", "errors", "cids"], `${label} report`);
    const cids = strictCids(report.cids, `${label} report cids`);
    assert.deepEqual(event.cids, cids, `${label} is recorded with other identifiers than its report carries`);
    assert.ok(Array.isArray(report.actions), `${label} actions must be an array`);
    const actions = report.actions.map((action, at) => strictAction(action, `${label} actions[${at}]`));
    const preedit = strictPreedit(report.preedit, `${label} preedit`);
    assert.ok(Array.isArray(report.errors), `${label} errors must be an array`);
    for (const [at, error] of report.errors.entries()) {
      exactObject(error, ["reason"], `${label} errors[${at}]`);
      assert.ok(typeof error.reason === "string" && error.reason.length > 0, `${label} errors[${at}].reason must be nonempty text`);
    }
    assert.equal(report.errors.length, 0, `native input transaction ${cids[0]} failed: ${report.errors.map(({ reason }) => reason).join("; ")}`);
    assert.equal(event.fields.dropped, false, `native input transaction ${cids[0]} was dropped`);
    assert.ok(Number.isSafeInteger(event.mono_ns), `${label} has no monotonic time`);
    transactions.push({ cids, actions, preedit, mono: event.mono_ns });
  }
  return transactions;
}

/**
 * Checks that each native input transaction of the image region of the raster probe `surface` that `events` record after the
 * transaction `after` of the input log `log` reached its sidecar unchanged under the same identifiers: the log holds exactly one
 * transaction with its identifiers, whose actions and preedit are those of the native report and whose sidecar answer echoed the
 * body {operation: "input", sequence, actions, preedit} under the same identifiers, and the host queued exactly one request of the
 * sidecar for the surface with those identifiers after the native report. Every transaction of the log after `after` must be such
 * a native transaction, and a check without one fails. A native transaction of a transaction at or before `after` is not counted;
 * one that the log does not hold fails. Returns the matched pairs `{native, entry}` in order.
 */
export function assertNativeInputDelivered(events, log, surface, after, label) {
  const natives = nativeInputTransactions(events);
  const requests = events.filter((event) => event?.event === "host.sidecar.request" && event.fields?.surface === surface
    && event.fields?.name === RASTER_SIDECAR);
  const matched = [];
  for (const native of natives) {
    const entries = log.filter((entry) => isDeepStrictEqual(entry.cids, native.cids));
    assert.equal(entries.length, 1, `${label}: the input log holds ${entries.length} transactions of native input ${native.cids[0]}`);
    const [entry] = entries;
    if (entry.sequence <= after) continue;
    const name = `${label}: input transaction ${entry.sequence} (${native.cids[0]})`;
    assert.deepEqual(entry.actions, native.actions, `${name} changed its actions before the sidecar request`);
    assert.deepEqual(entry.preedit, native.preedit, `${name} changed its preedit before the sidecar request`);
    assert.deepEqual(entry.errors, [], `${name} carried callback errors`);
    assert.deepEqual(entry.received, { operation: "input", sequence: entry.sequence, actions: native.actions, preedit: native.preedit },
      `${name} did not reach the sidecar unchanged`);
    assert.deepEqual(entry.receivedCids, native.cids, `${name} was answered under other correlation identifiers`);
    const sent = requests.filter((request) => isDeepStrictEqual(request.cids, native.cids));
    assert.equal(sent.length, 1, `${name} has ${sent.length} host requests of the sidecar, expected 1`);
    assert.ok(sent[0].mono_ns > native.mono, `${name}: the sidecar request preceded its native report`);
    matched.push({ native, entry });
  }
  const expected = log.filter((entry) => entry.sequence > after).map((entry) => entry.sequence);
  assert.ok(expected.length > 0, `${label}: the image region reported no input transaction`);
  assert.deepEqual(matched.map(({ entry }) => entry.sequence), expected,
    `${label}: the native input transactions do not match the input log one to one in order`);
  return matched;
}

/** The position of the event log at which a check of the delivery starts to read (assertNativeInputDelivered). */
export const nativeInputStart = (s) => currentEventOffsets(s.app.configDir);

/**
 * Reads the records written since `offsets` and checks the delivery (assertNativeInputDelivered) of the transactions of the raster
 * probe `surface` after the transaction `after` of its current input log. Returns the matched pairs.
 */
export async function nativeInputDelivered(s, surface, offsets, after, label) {
  await s.flushLog();
  const { events } = readEvents(s.app.configDir, offsets);
  const { log } = await s.get("rasterprobe.input", surface);
  return assertNativeInputDelivered(events, log, surface, after, label);
}
