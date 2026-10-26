import assert from "node:assert/strict";
import test from "node:test";

import { closeAddedMainPageWindows, readMainPageFootprint, reduceMainPageFootprint }
  from "../benchmark/cases/main-page-footprint.mjs";

const TEST_TIMEOUT = 5000;

test("main-page footprint records both windows and sums unique process footprints", { timeout: TEST_TIMEOUT }, () => {
  const result = reduceMainPageFootprint({
    windows: [
      { window: "main", pageProcess: 401 },
      { window: "secondary", pageProcess: 402 },
    ],
    rows: [
      { event: { event: "host.sampler.memory", seq: 5, ts_us: 10_000, mono_ns: 10_000_000,
        fields: { role: "page", window: "main", pid: 401, rss_kb: 2_000, footprint_kb: 11_000 } } },
      { event: { event: "host.sampler.memory", seq: 6, ts_us: 10_001, mono_ns: 10_001_000,
        fields: { role: "page", window: "secondary", pid: 402, rss_kb: 2_100, footprint_kb: 12_000 } } },
    ],
    loadAverage: [1.25, 1.5, 1.75],
  });

  assert.deepEqual(result, {
    ready: true,
    windowCount: 2,
    windows: [
      { window: "main", pageProcess: 401, footprintKB: 11_000,
        rssKB: 2_000, sample: { seq: 5, ts_us: 10_000, mono_ns: 10_000_000 } },
      { window: "secondary", pageProcess: 402, footprintKB: 12_000,
        rssKB: 2_100, sample: { seq: 6, ts_us: 10_001, mono_ns: 10_001_000 } },
    ],
    uniqueProcesses: [
      { pid: 401, footprintKB: 11_000, rssKB: 2_000,
        sample: { seq: 5, ts_us: 10_000, mono_ns: 10_000_000 } },
      { pid: 402, footprintKB: 12_000, rssKB: 2_100,
        sample: { seq: 6, ts_us: 10_001, mono_ns: 10_001_000 } },
    ],
    uniqueProcessCount: 2,
    totalFootprintKB: 23_000,
    loadAverage: [1.25, 1.5, 1.75],
  });
});

const pageRow = (seq, mono_ns, window, pid, footprint_kb, extra = {}) => ({ event: {
  event: "host.sampler.memory", seq, ts_us: mono_ns / 1000, mono_ns,
  fields: { role: "page", window, pid, rss_kb: footprint_kb + 100, footprint_kb, ...extra },
} });

test("main-page footprint selects the latest owner rows and counts one shared PID once", { timeout: TEST_TIMEOUT }, () => {
  const result = reduceMainPageFootprint({
    windows: [{ window: "main", pageProcess: 401 }, { window: "secondary", pageProcess: 401 }],
    rows: [
      pageRow(1, 10_000_000, "main", 401, 11_000),
      pageRow(2, 15_000_000, "main", 401, 12_000),
      pageRow(3, 15_001_000, "secondary", 401, 12_100),
      pageRow(4, 15_002_000, "main", 401, 99_000, { role: "document" }),
      pageRow(5, 15_003_000, "main", 499, 99_000),
    ],
    loadAverage: [2.25, 2.5, 2.75],
  });

  assert.equal(result.ready, true);
  assert.equal(result.windowCount, 2);
  assert.deepEqual(result.windows.map(({ window, pageProcess, footprintKB, rssKB }) => ({ window, pageProcess, footprintKB, rssKB })), [
    { window: "main", pageProcess: 401, footprintKB: 12_000, rssKB: 12_100 },
    { window: "secondary", pageProcess: 401, footprintKB: 12_100, rssKB: 12_200 },
  ]);
  assert.deepEqual(result.uniqueProcesses, [{ pid: 401, footprintKB: 12_100, rssKB: 12_200,
    sample: { seq: 3, ts_us: 15_001, mono_ns: 15_001_000 } }]);
  assert.equal(result.uniqueProcessCount, 1);
  assert.equal(result.totalFootprintKB, 12_100);
  assert.deepEqual(result.loadAverage, [2.25, 2.5, 2.75]);
});

test("main-page footprint waits on host.log notices until each assigned PID has a sampler row",
  { timeout: TEST_TIMEOUT }, async () => {
  const samples = [[], [
    pageRow(10, 21_000_000, "main", 401, 10_000),
    pageRow(11, 21_001_000, "secondary", 402, 11_000),
  ]];
  const calls = [];
  let notices = 0;
  let query = 0;
  const session = {
    client: { request: async (name, params) => {
      calls.push([name, params]);
      assert.equal(name, "log.query");
      return { rows: samples[Math.min(query++, samples.length - 1)], next: null };
    } },
    get: async (name) => {
      assert.equal(name, "host.log");
      return { notices };
    },
    until: async (name, predicate) => {
      assert.equal(name, "host.log");
      notices += 1;
      assert.equal(predicate({ notices }), true);
    },
  };
  const result = await readMainPageFootprint(session,
    [{ window: "main", pageProcess: 401 }, { window: "secondary", pageProcess: 402 }], 7,
    () => [1, 2, 3]);

  assert.equal(notices, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, params]) => params.since === 7));
  assert.equal(result.totalFootprintKB, 21_000);
});

test("main-page footprint reports the latest sampler error instead of dropping it", { timeout: TEST_TIMEOUT }, () => {
  assert.throws(() => reduceMainPageFootprint({
    windows: [{ window: "main", pageProcess: 401 }],
    rows: [
      pageRow(1, 10_000_000, "main", 401, 10_000),
      pageRow(2, 11_000_000, "main", 401, undefined, { error: "footprint unavailable" }),
    ],
    loadAverage: [1, 1, 1],
  }), /sampler failed for main PID 401: footprint unavailable/);
});

test("main-page footprint reports a window-level sampler error without a PID", { timeout: TEST_TIMEOUT }, () => {
  assert.throws(() => reduceMainPageFootprint({
    windows: [{ window: "main", pageProcess: 401 }],
    rows: [
      { event: { event: "host.sampler.memory", seq: 1, ts_us: 10_000, mono_ns: 10_000_000,
        fields: { role: "page", window: "main", error: "window facts unavailable" } } },
      pageRow(2, 11_000_000, "main", 401, 10_500),
    ],
    loadAverage: [1, 1, 1],
  }), /sampler failed for main: window facts unavailable/);
});

test("main-page footprint rejects a malformed window-level sampler error", { timeout: TEST_TIMEOUT }, () => {
  assert.throws(() => reduceMainPageFootprint({
    windows: [{ window: "main", pageProcess: 401 }],
    rows: [
      { event: { event: "host.sampler.memory", seq: 1, ts_us: 10_000, mono_ns: 10_000_000,
        fields: { role: "page", window: "main", error: 5 } } },
      pageRow(2, 11_000_000, "main", 401, 10_500),
    ],
    loadAverage: [1, 1, 1],
  }), /sampler error for main is not a nonempty string/);
});

test("two-window main-page footprint refuses a changed baseline page PID", { timeout: TEST_TIMEOUT }, () => {
  assert.throws(() => reduceMainPageFootprint({
    baselineWindows: [{ window: "main", pageProcess: 401 }],
    windows: [{ window: "main", pageProcess: 402 }, { window: "secondary", pageProcess: 403 }],
    rows: [
      pageRow(3, 12_000_000, "main", 402, 10_500),
      pageRow(4, 12_001_000, "secondary", 403, 11_000),
    ],
    loadAverage: [1, 1, 1],
  }), /baseline page process changed for main: 401 to 402/);
});

test("main-page footprint cleanup closes only added windows and restores baseline identities",
  { timeout: TEST_TIMEOUT }, async () => {
  const original = ["main"];
  const windows = [...original, "added-a", "added-b"];
  const closed = [];
  const session = {
    get: async (name) => {
      assert.equal(name, "host.windows");
      return windows.map((window) => ({ window }));
    },
    on: (window) => ({ close: async () => {
      closed.push(window);
      windows.splice(windows.indexOf(window), 1);
    } }),
    windows: async (count) => assert.equal(windows.length, count),
  };

  await closeAddedMainPageWindows(session, [{ window: "main" }]);

  assert.deepEqual(closed, ["added-a", "added-b"]);
  assert.deepEqual(windows, original);
});

test("main-page footprint cleanup attempts every added window and preserves close errors",
  { timeout: TEST_TIMEOUT }, async () => {
  const windows = ["main", "added-a", "added-b"];
  const attempted = [];
  const session = {
    get: async () => windows.map((window) => ({ window })),
    on: (window) => ({ close: async () => {
      attempted.push(window);
      if (window === "added-a") throw new Error("close failed");
      windows.splice(windows.indexOf(window), 1);
    } }),
    windows: async () => assert.fail("baseline wait must not hide a failed close"),
  };

  await assert.rejects(closeAddedMainPageWindows(session, [{ window: "main" }]),
    (error) => error instanceof AggregateError && /could not close every added window/.test(error.message));
  assert.deepEqual(attempted, ["added-a", "added-b"]);
  assert.ok(windows.includes("main"), "cleanup closed the baseline window");
});
