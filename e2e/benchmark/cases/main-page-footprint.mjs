import { allRows } from "../../chains.mjs";

const newer = (candidate, current) => candidate.mono_ns > current.mono_ns ||
  candidate.mono_ns === current.mono_ns && candidate.seq > current.seq;

/** Reduces page-process sampler rows for the exact main windows to one physical-footprint summary. */
export function reduceMainPageFootprint({ windows, rows, loadAverage, baselineWindows }) {
  if (!Array.isArray(windows) || ![1, 2].includes(windows.length)) {
    throw new Error(`main-page footprint requires one or two windows, found ${windows?.length}`);
  }
  if (!Array.isArray(rows)) throw new Error("main-page footprint sampler rows must be an array");
  if (!Array.isArray(loadAverage) || loadAverage.length !== 3 ||
      loadAverage.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`main-page footprint load average is invalid: ${JSON.stringify(loadAverage)}`);
  }

  const windowById = new Map();
  for (const row of windows) {
    if (typeof row?.window !== "string" || row.window === "" || windowById.has(row.window)) {
      throw new Error(`main-page footprint window identity is invalid or duplicated: ${JSON.stringify(row?.window)}`);
    }
    if (!Number.isSafeInteger(row.pageProcess) || row.pageProcess <= 0) {
      throw new Error(`main-page footprint page process for ${row.window} is invalid: ${JSON.stringify(row.pageProcess)}`);
    }
    windowById.set(row.window, row.pageProcess);
  }

  if (baselineWindows !== undefined) {
    if (!Array.isArray(baselineWindows) || baselineWindows.length === 0) {
      throw new Error("main-page footprint baseline windows must be a nonempty array");
    }
    const seenBaseline = new Set();
    for (const row of baselineWindows) {
      if (typeof row?.window !== "string" || row.window === "" || seenBaseline.has(row.window)) {
        throw new Error(`main-page footprint baseline window identity is invalid or duplicated: ${JSON.stringify(row?.window)}`);
      }
      if (!Number.isSafeInteger(row.pageProcess) || row.pageProcess <= 0) {
        throw new Error(`main-page footprint baseline page process for ${row.window} is invalid: ${JSON.stringify(row.pageProcess)}`);
      }
      const currentPid = windowById.get(row.window);
      if (currentPid === undefined) throw new Error(`main-page footprint baseline window ${row.window} is missing from the current sample`);
      if (currentPid !== row.pageProcess) {
        throw new Error(`main-page footprint baseline page process changed for ${row.window}: ${row.pageProcess} to ${currentPid}`);
      }
      seenBaseline.add(row.window);
    }
  }

  const latestByWindow = new Map();
  for (const row of rows) {
    const event = row?.event;
    const fields = event?.fields;
    if (event?.event !== "host.sampler.memory" || fields?.role !== "page" || !windowById.has(fields.window)) continue;
    if (Object.hasOwn(fields, "error") && (typeof fields.error !== "string" || fields.error === "")) {
      throw new Error(`main-page footprint sampler error for ${fields.window} is not a nonempty string: ` +
        `${JSON.stringify(fields.error)}`);
    }
    if ((fields.pid === undefined || fields.pid === null) && typeof fields.error === "string" && fields.error !== "") {
      throw new Error(`main-page footprint sampler failed for ${fields.window}: ${fields.error}`);
    }
    if (fields.pid !== windowById.get(fields.window)) continue;
    if (!Number.isSafeInteger(event.seq) || event.seq <= 0 || !Number.isSafeInteger(event.ts_us) || event.ts_us <= 0 ||
        !Number.isSafeInteger(event.mono_ns) || event.mono_ns <= 0) {
      throw new Error(`main-page footprint sample for ${fields.window} has invalid event identity or timestamp`);
    }
    const current = latestByWindow.get(fields.window);
    if (current === undefined || newer(event, current.event)) latestByWindow.set(fields.window, row);
  }

  const missingWindows = [...windowById.keys()].filter((window) => !latestByWindow.has(window));
  if (missingWindows.length > 0) return { ready: false, missingWindows };

  const measuredWindows = [];
  const processByPid = new Map();
  for (const [window, pageProcess] of windowById) {
    const row = latestByWindow.get(window);
    const { event } = row;
    const fields = event.fields;
    if (typeof fields.error === "string" && fields.error !== "") {
      throw new Error(`main-page footprint sampler failed for ${window} PID ${pageProcess}: ${fields.error}`);
    }
    if (!Number.isSafeInteger(fields.footprint_kb) || fields.footprint_kb <= 0) {
      throw new Error(`main-page footprint sampler returned invalid footprint_kb for ${window} PID ${pageProcess}: ` +
        `${JSON.stringify(fields.footprint_kb)}`);
    }
    if (!Number.isSafeInteger(fields.rss_kb) || fields.rss_kb <= 0) {
      throw new Error(`main-page footprint sampler returned invalid rss_kb context for ${window} PID ${pageProcess}: ` +
        `${JSON.stringify(fields.rss_kb)}`);
    }
    const sample = { seq: event.seq, ts_us: event.ts_us, mono_ns: event.mono_ns };
    const measured = { window, pageProcess, footprintKB: fields.footprint_kb, rssKB: fields.rss_kb, sample };
    measuredWindows.push(measured);

    const current = processByPid.get(pageProcess);
    if (current === undefined || newer(event, current.event)) {
      processByPid.set(pageProcess, { pid: pageProcess, footprintKB: fields.footprint_kb,
        rssKB: fields.rss_kb, sample, event });
    }
  }

  const uniqueProcesses = [...processByPid.values()]
    .map(({ pid, footprintKB, rssKB, sample }) => ({ pid, footprintKB, rssKB, sample }))
    .sort((left, right) => left.pid - right.pid);
  const totalFootprintKB = uniqueProcesses.reduce((total, process) => total + process.footprintKB, 0);
  if (!Number.isSafeInteger(totalFootprintKB)) throw new Error("main-page footprint total exceeds the safe integer range");

  return {
    ready: true,
    windowCount: measuredWindows.length,
    windows: measuredWindows,
    uniqueProcesses,
    uniqueProcessCount: uniqueProcesses.length,
    totalFootprintKB,
    loadAverage: [...loadAverage],
  };
}

/** Waits for a sampler reading for each exact page process, using host.log notifications instead of polling. */
export async function readMainPageFootprint(session, windows, since, loadavg, baselineWindows) {
  let last = "no page-process sampler rows were read";
  for (;;) {
    const before = await session.get("host.log");
    const rows = await allRows(session, { channel: "all", event: "host.sampler.memory", since });
    const result = reduceMainPageFootprint({ windows, rows, loadAverage: loadavg(), baselineWindows });
    if (result.ready) return result;
    last = `waiting for page-process samples of ${result.missingWindows.join(", ")}`;
    await session.until("host.log", (value) => value.notices > before.notices,
      `the log announced no further change; ${last}`);
  }
}

/** Closes only windows added after baseline and verifies the exact original window identity set. */
export async function closeAddedMainPageWindows(session, baselineWindows) {
  if (!Array.isArray(baselineWindows) || baselineWindows.length === 0) {
    throw new Error("main-page footprint requires a nonempty baseline window set");
  }
  const baseline = baselineWindows.map((row) => row?.window);
  if (baseline.some((window) => typeof window !== "string" || window === "") || new Set(baseline).size !== baseline.length) {
    throw new Error(`main-page footprint baseline window identities are invalid: ${JSON.stringify(baseline)}`);
  }

  const errors = [];
  let current;
  try {
    current = await session.get("host.windows");
  } catch (error) {
    throw new Error(`main-page footprint could not read windows for cleanup: ${error.message}`, { cause: error });
  }
  for (const row of current) {
    if (baseline.includes(row.window)) continue;
    try {
      await session.on(row.window).close();
    } catch (error) {
      errors.push(new Error(`main-page footprint could not close added window ${row.window}: ${error.message}`, { cause: error }));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "main-page footprint could not close every added window");

  await session.windows(baseline.length, "added main-page footprint windows remained open");
  const restored = (await session.get("host.windows")).map((row) => row.window);
  if (restored.length !== baseline.length || baseline.some((window) => !restored.includes(window))) {
    throw new Error(`main-page footprint cleanup changed the baseline window set: ${JSON.stringify({ baseline, restored })}`);
  }
}
