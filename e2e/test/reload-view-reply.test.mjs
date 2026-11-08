import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptedCurrentViewReplies, currentPageNativeViewCalls, currentPageViewCallCoverage,
} from "../reload-view-reply.mjs";

const workbenchEvent = (start, event, fields) => ({ ts_us: 10, level: "debug", layer: "workbench", start, event, fields });
const dispatch = (fields) => ({ ts_us: 1, level: "debug", layer: "host", event: "host.view.reply.dispatch", fields });
const query = { window: "main", page: "page-after-reload", plugin: "probeplain", surface: "probe-tab" };
const coverageQuery = { ...query, page: "6f1d2a3e-1111-4a2b-8c3d-00000000000a" };
const start = (page = coverageQuery.page, mono_ns = 1_000_000_000) => ({ ts_us: 2, mono_ns, seq: 2, level: "info", layer: "workbench",
  start: page, event: "workbench.start", fields: { started_at: 1000.5 } });
const clock = (page = coverageQuery.page, trip_us = 100, resolution_us = 10) => ({ ts_us: 2, mono_ns: 1_000_000_000, seq: 3,
  level: "info", layer: "workbench", start: page, event: "workbench.log.clock", fields: { trip_us, resolution_us } });
const nativeCall = (id, mono_ns = 1_000_200_000, plugin = "probeplain", surface = "probe-tab") => ({ ts_us: 3,
  mono_ns, seq: id + 3, level: "debug", layer: "host", event: "host.view.call", fields: { plugin, surface, id, command: "runtime.settings.read" } });

test("native reply acceptance matches only the current page and source generation", () => {
  const events = [
    workbenchEvent("page-before-reload", "workbench.view.call", {
      plugin: "probeplain", surface: "probe-tab", generation: 3, id: 9, command: "runtime.shortcuts.read",
    }),
    workbenchEvent("page-before-reload", "workbench.view.reply", {
      plugin: "probeplain", surface: "probe-tab", generation: 3, id: 9, outcome: "result",
    }),
    workbenchEvent("page-after-reload", "workbench.view.call", {
      plugin: "probeplain", surface: "probe-tab", generation: 3, id: 9, command: "runtime.shortcuts.read",
    }),
    workbenchEvent("page-after-reload", "workbench.view.reply", {
      plugin: "probeplain", surface: "probe-tab", generation: 3, id: 9, outcome: "result",
    }),
    dispatch({ window: "main", page: "page-before-reload", surface: "probe-tab", generation: 3, id: 9, outcome: "result", disposition: "posted" }),
    dispatch({ window: "main", page: "page-after-reload", surface: "probe-tab", generation: 4, id: 9, outcome: "result", disposition: "posted" }),
    dispatch({ window: "other", page: "page-after-reload", surface: "probe-tab", generation: 3, id: 9, outcome: "result", disposition: "posted" }),
    dispatch({ window: "main", page: "page-after-reload", surface: "probe-tab", generation: 3, id: 12, outcome: "result", disposition: "discarded", reason: "view-generation-not-current" }),
    workbenchEvent("page-after-reload", "workbench.view.call", {
      plugin: "probeplain", surface: "probe-tab", generation: 3, id: 10, command: "runtime.shortcuts.read",
    }),
    workbenchEvent("page-after-reload", "workbench.view.reply", {
      plugin: "probeplain", surface: "probe-tab", generation: 3, id: 10, outcome: "result",
    }),
    dispatch({ window: "main", page: "page-after-reload", surface: "probe-tab", generation: 3, id: 10, outcome: "result", disposition: "posted" }),
    workbenchEvent("page-after-reload", "workbench.view.call", {
      plugin: "probeplain", surface: "probe-tab", generation: 3, id: 11, command: "runtime.shortcuts.read",
    }),
    workbenchEvent("page-after-reload", "workbench.view.reply", {
      plugin: "probeplain", surface: "probe-tab", generation: 3, id: 11, outcome: "error",
    }),
    dispatch({ window: "main", page: "page-after-reload", surface: "probe-tab", generation: 3, id: 11, outcome: "error", disposition: "posted" }),
    // A large unrelated workbench.call may be truncated without affecting the host-dispatch join.
    workbenchEvent("page-after-reload", "workbench.call", { name: "viewReply", truncated: true }),
  ];
  assert.deepEqual(acceptedCurrentViewReplies(events, query), [
    { ...query, generation: 3, id: 10, outcome: "result" },
    { ...query, generation: 3, id: 11, outcome: "error" },
  ]);
  assert.deepEqual(acceptedCurrentViewReplies(events.filter((event) =>
    !(event.layer === "host" && event.event === "host.view.reply.dispatch" && event.fields.id === 10)), query), [
    { ...query, generation: 3, id: 11, outcome: "error" },
  ], "a source reply without native post acceptance was treated as accepted");
  assert.throws(() => acceptedCurrentViewReplies([...events,
    dispatch({ window: "main", page: "page-after-reload", surface: "probe-tab", generation: 3, id: 10, outcome: "result", disposition: "posted" }),
  ], query), /2 native dispatch records/);
  assert.throws(() => acceptedCurrentViewReplies([...events,
    dispatch({ window: "main", page: "page-after-reload", surface: "probe-tab", generation: 3, id: 13, outcome: "other", disposition: "posted" }),
  ], query), /has invalid fields/);
  assert.throws(() => acceptedCurrentViewReplies([...events,
    dispatch({ window: "main", page: "page-after-reload", surface: "probe-tab", generation: 3, id: 14, outcome: "result", disposition: "discarded", reason: "unknown" }),
  ], query), /invalid discard reason/);
});

test("every native view call in the sealed set has a current-page receipt and settlement", () => {
  const nativeCalls = [
    { plugin: "probeplain", surface: "probe-tab", id: 20 },
    { plugin: "probeplain", surface: "probe-tab", id: 21 },
  ];
  const events = [
    workbenchEvent(coverageQuery.page, "workbench.view.call", {
      plugin: "probeplain", surface: "probe-tab", generation: 7, id: 20, command: "runtime.settings.read",
    }),
    workbenchEvent(coverageQuery.page, "workbench.view.reply", {
      plugin: "probeplain", surface: "probe-tab", generation: 7, id: 20, outcome: "result",
    }),
    dispatch({ window: "main", page: coverageQuery.page, surface: "probe-tab", generation: 7, id: 20,
      outcome: "result", disposition: "posted" }),
  ];
  assert.equal(currentPageViewCallCoverage(events, { ...coverageQuery, calls: nativeCalls }), undefined,
    "the first accepted reply hid a native call without a current-page settlement");
  events.push(
    workbenchEvent(coverageQuery.page, "workbench.view.call", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 21,
      command: "runtime.settings.read" }),
    workbenchEvent(coverageQuery.page, "workbench.view.reply", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 21,
      outcome: "result" }),
    dispatch({ window: "main", page: coverageQuery.page, surface: "probe-tab", generation: 7, id: 21,
      outcome: "result", disposition: "posted" }),
  );
  assert.equal(currentPageViewCallCoverage(events, { ...coverageQuery, calls: nativeCalls }).length, 2,
    "all sealed calls remained incomplete after their current-page settlements arrived");
});

test("native call selection uses the replacement page clock bound and rejects the uncertain interval", () => {
  const events = [start(), clock(), nativeCall(21, 1_000_200_000), nativeCall(22, 999_900_000)];
  assert.deepEqual(currentPageNativeViewCalls(events, { page: coverageQuery.page }), [
    { plugin: "probeplain", surface: "probe-tab", id: 21, mono_ns: 1_000_200_000 },
  ]);
  assert.throws(() => currentPageNativeViewCalls([start(), clock(), nativeCall(23, 1_000_020_000)], { page: coverageQuery.page }),
    /falls within the page-start clock uncertainty/);
});

test("a rounded zero page-clock trip is valid when its resolution is positive", () => {
  const events = [start(), clock(coverageQuery.page, 0, 10), nativeCall(24, 1_000_020_000)];
  assert.deepEqual(currentPageNativeViewCalls(events, { page: coverageQuery.page }), [
    { plugin: "probeplain", surface: "probe-tab", id: 24, mono_ns: 1_000_020_000 },
  ]);
});

test("page identity matches the page of the workbench.start record exactly", () => {
  const page = "6f1d2a3e-1111-4a2b-8c3d-00000000000b";
  const events = [start(page), clock(page, 0, 10), nativeCall(25, 1_000_020_000)];
  assert.deepEqual(currentPageNativeViewCalls(events, { page }), [
    { plugin: "probeplain", surface: "probe-tab", id: 25, mono_ns: 1_000_020_000 },
  ]);
  assert.throws(() => currentPageNativeViewCalls(events, { page: "6F1D2A3E-1111-4A2B-8C3D-00000000000B" }), /no unique valid workbench.start record/);
});

test("a sealed native call stays pending until its delayed current-page reply is posted", () => {
  const events = [start(), clock(), nativeCall(30)];
  const calls = currentPageNativeViewCalls(events, { page: coverageQuery.page });
  assert.deepEqual(calls.map(({ id }) => id), [30]);
  assert.equal(currentPageViewCallCoverage(events, { ...coverageQuery, calls }), undefined,
    "a missing page event batch was treated as drained");
  events.push(
    workbenchEvent(coverageQuery.page, "workbench.view.call", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 30,
      command: "runtime.settings.read" }),
    workbenchEvent(coverageQuery.page, "workbench.view.reply", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 30,
      outcome: "result" }),
    dispatch({ window: "main", page: coverageQuery.page, surface: "probe-tab", generation: 7, id: 30,
      outcome: "result", disposition: "posted" }),
  );
  assert.deepEqual(currentPageViewCallCoverage(events, { ...coverageQuery, calls }), [
    { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 30, outcome: "result" },
  ]);
});

test("a current-page cancel-only record settles one native call", () => {
  const events = [start(), clock(), nativeCall(31), workbenchEvent(coverageQuery.page, "workbench.view.call.cancel", {
    plugin: "probeplain", surface: "probe-tab", generation: 7, id: 31, command: "runtime.settings.read",
  })];
  const calls = currentPageNativeViewCalls(events, { page: coverageQuery.page });
  const oldPageOnly = events.filter((event) => event.layer !== "workbench" || event.start !== coverageQuery.page);
  assert.equal(currentPageViewCallCoverage(oldPageOnly, { ...coverageQuery, calls }), undefined,
    "an old-page receipt was treated as current-page settlement");
  assert.deepEqual(currentPageViewCallCoverage(events, { ...coverageQuery, calls }), [
    { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 31, outcome: "cancel" },
  ]);
});

test("an unrelated cancellation without generation does not invalidate target coverage", () => {
  const events = [start(), clock(), nativeCall(39),
    workbenchEvent(coverageQuery.page, "workbench.view.call", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 39,
      command: "runtime.settings.read" }),
    workbenchEvent(coverageQuery.page, "workbench.view.reply", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 39,
      outcome: "result" }),
    dispatch({ window: "main", page: coverageQuery.page, surface: "probe-tab", generation: 7, id: 39,
      outcome: "result", disposition: "posted" }),
    workbenchEvent(coverageQuery.page, "workbench.view.call.cancel", {
      plugin: "browser", surface: "other-tab", id: 5, command: "runtime.settings.read",
    })];
  const calls = currentPageNativeViewCalls(events, { page: coverageQuery.page });
  assert.deepEqual(currentPageViewCallCoverage(events, { ...coverageQuery, calls }), [
    { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 39, outcome: "result" },
  ]);
});

test("a target cancellation without generation is not an exact settlement", () => {
  const events = [start(), clock(), nativeCall(40), workbenchEvent(coverageQuery.page, "workbench.view.call.cancel", {
    plugin: "probeplain", surface: "probe-tab", id: 40, command: "runtime.settings.read",
  })];
  const calls = currentPageNativeViewCalls(events, { page: coverageQuery.page });
  assert.throws(() => currentPageViewCallCoverage(events, { ...coverageQuery, calls }),
    /has an invalid source identity/);
});

test("a receipt followed by cancellation settles only its exact page generation", () => {
  const events = [start(), clock(), nativeCall(32),
    workbenchEvent(coverageQuery.page, "workbench.view.call", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 32,
      command: "runtime.settings.read" }),
    workbenchEvent(coverageQuery.page, "workbench.view.call.cancel", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 32,
      command: "runtime.settings.read" })];
  const calls = currentPageNativeViewCalls(events, { page: coverageQuery.page });
  assert.deepEqual(currentPageViewCallCoverage(events, { ...coverageQuery, calls })[0], {
    plugin: "probeplain", surface: "probe-tab", generation: 7, id: 32, outcome: "cancel",
  });
  events.push(workbenchEvent(coverageQuery.page, "workbench.view.call.cancel", { plugin: "probeplain", surface: "probe-tab", generation: 8,
    id: 32, command: "runtime.settings.read" }));
  assert.throws(() => currentPageViewCallCoverage(events, { ...coverageQuery, calls }), /matches 2 page generations/);
});

test("an old-page tuple does not make a unique current-page receipt ambiguous", () => {
  const events = [start(), clock(), nativeCall(33),
    workbenchEvent("900", "workbench.view.call", { plugin: "probeplain", surface: "probe-tab", generation: 6, id: 33,
      command: "runtime.settings.read" }),
    workbenchEvent("900", "workbench.view.reply", { plugin: "probeplain", surface: "probe-tab", generation: 6, id: 33,
      outcome: "result" }),
    workbenchEvent(coverageQuery.page, "workbench.view.call", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 33,
      command: "runtime.settings.read" }),
    workbenchEvent(coverageQuery.page, "workbench.view.reply", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 33,
      outcome: "result" }),
    dispatch({ window: "main", page: coverageQuery.page, surface: "probe-tab", generation: 7, id: 33,
      outcome: "result", disposition: "posted" })];
  const calls = currentPageNativeViewCalls(events, { page: coverageQuery.page });
  assert.deepEqual(currentPageViewCallCoverage(events, { ...coverageQuery, calls }), [
    { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 33, outcome: "result" },
  ]);
});

test("reply coverage waits for native post evidence and rejects discarded or malformed dispatch", () => {
  const events = [start(), clock(), nativeCall(34),
    workbenchEvent(coverageQuery.page, "workbench.view.call", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 34,
      command: "runtime.settings.read" }),
    workbenchEvent(coverageQuery.page, "workbench.view.reply", { plugin: "probeplain", surface: "probe-tab", generation: 7, id: 34,
      outcome: "result" })];
  const calls = currentPageNativeViewCalls(events, { page: coverageQuery.page });
  assert.equal(currentPageViewCallCoverage(events, { ...coverageQuery, calls }), undefined,
    "a page reply without host post evidence was treated as settled");
  events.push(dispatch({ window: "main", page: coverageQuery.page, surface: "probe-tab", generation: 7, id: 34,
    outcome: "result", disposition: "discarded", reason: "view-generation-not-current" }));
  assert.throws(() => currentPageViewCallCoverage(events, { ...coverageQuery, calls }), /no matching posted native dispatch/);
  events.push(dispatch({ window: "main", page: coverageQuery.page, surface: "probe-tab", generation: 7, id: 34,
    outcome: "result", disposition: "posted" }));
  assert.throws(() => currentPageViewCallCoverage(events, { ...coverageQuery, calls }), /2 native dispatch records/);
  const malformed = events.filter((event) => !(event.layer === "host" && event.event === "host.view.reply.dispatch" &&
    event.fields?.id === 34));
  malformed.push(dispatch({ window: "main", page: coverageQuery.page, surface: "probe-tab", generation: 7,
    id: 34, outcome: "result", disposition: "posted", reason: "unexpected" }));
  assert.throws(() => currentPageViewCallCoverage(malformed, { ...coverageQuery, calls }),
    /has a reason for a posted dispatch/);
});

test("duplicate native calls in one sealed set have no unique source identity", () => {
  assert.throws(() => currentPageNativeViewCalls([start(), clock(), nativeCall(36), nativeCall(36, 1_000_300_000)],
    { page: coverageQuery.page }), /is duplicated in the sealed set/);
});
