import { isDeepStrictEqual } from "node:util";

const text = (value, path) => {
  if (typeof value !== "string" || value === "") throw new Error(`${path} must be nonempty text`);
  return value;
};

function pageSample(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a page sample object`);
  }
  if (!Number.isSafeInteger(value.frames) || value.frames < 0) {
    throw new Error(`${path}.frames must be a nonnegative safe integer`);
  }
  if (!Number.isFinite(value.performanceNow) || value.performanceNow < 0) {
    throw new Error(`${path}.performanceNow must be finite and nonnegative`);
  }
  if (!Number.isFinite(value.timeOrigin) || value.timeOrigin <= 0) {
    throw new Error(`${path}.timeOrigin must be finite and positive`);
  }
  return { frames: value.frames, performanceNow: value.performanceNow, timeOrigin: value.timeOrigin };
}

/** Waits for the plugin host's declared command and status registration trace rows. */
export async function waitForPluginHostRegistrations({ session, plugin, registrations, since, readRows }) {
  text(plugin, "plugin");
  if (!Array.isArray(registrations) || registrations.length === 0 || typeof readRows !== "function") {
    throw new TypeError("plugin-host readiness requires registrations and a row reader");
  }
  const expected = new Set(registrations.map(({ kind, name }) => {
    if (kind !== "command" && kind !== "status") throw new TypeError(`unsupported plugin-host registration kind ${kind}`);
    text(name, "registration.name");
    return `${kind}:${name}`;
  }));
  const surface = `plugin:${plugin}`;
  let observed = new Set();
  const find = async () => {
    const rows = await readRows(since);
    observed = new Set(rows.flatMap((row) => {
      const event = row?.event;
      const fields = event?.fields;
      if (event?.event !== "page.trace.surface.registration" || fields?.phase !== "registered" ||
          fields.surface !== surface || (fields.kind !== "command" && fields.kind !== "status") ||
          typeof fields.name !== "string") return [];
      return [`${fields.kind}:${fields.name}`];
    }));
    return [...expected].every((entry) => observed.has(entry));
  };

  for (;;) {
    const before = await session.get("host.log");
    if (!Number.isSafeInteger(before?.notices) || before.notices < 0) {
      throw new Error("host.log readiness notice count is invalid");
    }
    if (await find()) return;
    const missing = [...expected].filter((entry) => !observed.has(entry));
    await session.until("host.log", (value) => value.notices > before.notices,
      `plugin host ${plugin} did not register ${missing.join(", ")}`, { timeout: 15000 });
  }
}

/** Reads one host command result and verifies that status.get pulls the same published snapshot. */
export async function readPluginHostSample(session, command, status) {
  text(command, "command");
  text(status, "status");
  const result = await session.run(command);
  const snapshot = await session.get(status);
  if (!snapshot || typeof snapshot !== "object" || !isDeepStrictEqual(snapshot.value, result)) {
    throw new Error(`plugin host status ${status} did not pull the sample returned by ${command}`);
  }
  return result;
}

/** Selects the measured host rows and reports a window-facts error before callers wait for a missing host row. */
export function selectPluginHostSamplerRows(rows, plugin, window) {
  text(plugin, "plugin");
  text(window, "window");
  if (!Array.isArray(rows)) throw new Error("samplerRows must be an array");
  const matching = [];
  for (const [index, row] of rows.entries()) {
    const event = row?.event;
    if (event?.event !== "host.sampler.memory") continue;
    const fields = event.fields;
    if (fields?.window !== window) continue;
    if (fields.role === "page" && Object.hasOwn(fields, "error")) {
      if (typeof fields.error !== "string" || fields.error === "") {
        throw new Error(`window sampler error for ${window} at row ${index} must be nonempty text`);
      }
      throw new Error(`window facts failed for plugin host ${plugin} in ${window}: ${fields.error}`);
    }
    if (fields.role !== "plugin-host" || fields.plugin !== plugin) continue;
    if (Object.hasOwn(fields, "error")) {
      if (typeof fields.error !== "string" || fields.error === "") {
        throw new Error(`plugin-host sampler error for ${plugin} in ${window} must be nonempty text`);
      }
      throw new Error(`plugin-host sampler failed for ${plugin} in ${window}: ${fields.error}`);
    }
    matching.push(row);
  }
  return matching;
}

/** Restores the active registry even when earlier cleanup steps fail. */
export async function cleanupPluginHostFixture({ ensureWindow, readState, plugin, previousRegistry,
  removePlugin, restoreRegistry, removeDirectory, directory }) {
  const errors = [];
  const record = (error) => errors.push(error instanceof Error ? error : new Error(String(error)));
  let windowReady = false;
  let pluginAbsent = false;

  try {
    await ensureWindow();
    windowReady = true;
  } catch (error) {
    record(error);
  }

  try {
    const state = await readState();
    const fixture = state.plugins.find((row) => row.id === plugin);
    if (fixture?.installed) {
      try {
        await removePlugin();
      } catch (error) {
        record(error);
      }
    }

    const afterRemoval = await readState();
    const fixtureAfterRemoval = afterRemoval.plugins.find((row) => row.id === plugin);
    pluginAbsent = fixtureAfterRemoval !== undefined && fixtureAfterRemoval.installed === false;
    if (!pluginAbsent) {
      record(new Error(`fixture plugin ${plugin} is still installed or its removal state is unavailable`));
    }
  } catch (error) {
    record(error);
  }

  let registryRestored = false;
  try {
    await restoreRegistry(previousRegistry);
    const state = await readState();
    if (state.registry !== previousRegistry) {
      throw new Error(`active registry is ${state.registry}, expected ${previousRegistry}`);
    }
    registryRestored = true;
  } catch (error) {
    record(error);
  }

  if (windowReady && registryRestored && pluginAbsent) {
    try {
      await removeDirectory();
    } catch (error) {
      record(error);
    }
  } else {
    record(new Error(`retained temporary registry directory ${directory}; cleanup state is unconfirmed`));
  }

  if (errors.length) throw new AggregateError(errors, `plugin-host fixture cleanup failed for ${plugin}`);
}

/** Reduces two fixture-command samples and the sampler rows that identify the measured host process. */
export function reducePluginHostRafMeasurement({ plugin, window, start, end, samplerRows }) {
  text(plugin, "plugin");
  text(window, "window");
  const first = pageSample(start, "start");
  const last = pageSample(end, "end");
  if (first.timeOrigin !== last.timeOrigin) {
    throw new Error(`page clock origin changed: ${first.timeOrigin} to ${last.timeOrigin}`);
  }
  const matching = selectPluginHostSamplerRows(samplerRows, plugin, window);

  const elapsedMs = last.performanceNow - first.performanceNow;
  if (elapsedMs <= 0) throw new Error(`page clock did not advance: ${first.performanceNow} to ${last.performanceNow}`);
  if (last.frames < first.frames) throw new Error(`RAF callback count moved backward: ${first.frames} to ${last.frames}`);

  if (matching.length < 2) {
    throw new Error(`plugin-host sampler requires at least two rows for ${plugin} in ${window}, found ${matching.length}`);
  }

  const sampler = [];
  let pid;
  let previousSeq = 0;
  let previousMonoNs = 0;
  for (const [index, row] of matching.entries()) {
    const { event } = row;
    const fields = event.fields;
    if (!Number.isSafeInteger(fields.pid) || fields.pid <= 0) {
      throw new Error(`plugin-host sampler row ${index} for ${plugin} in ${window} has no positive PID`);
    }
    if (!Number.isSafeInteger(fields.rss_kb) || fields.rss_kb <= 0 ||
        !Number.isSafeInteger(fields.footprint_kb) || fields.footprint_kb <= 0) {
      throw new Error(`plugin-host sampler row ${index} for ${plugin} in ${window} has invalid memory sizes`);
    }
    if (!Number.isSafeInteger(event.seq) || event.seq <= previousSeq ||
        !Number.isSafeInteger(event.mono_ns) || event.mono_ns <= previousMonoNs) {
      throw new Error(`plugin-host sampler rows for ${plugin} in ${window} are not in increasing host-clock order`);
    }
    if (pid !== undefined && pid !== fields.pid) {
      throw new Error(`plugin-host process changed for ${plugin} in ${window}: ${pid} to ${fields.pid}`);
    }
    pid = fields.pid;
    previousSeq = event.seq;
    previousMonoNs = event.mono_ns;
    sampler.push({ seq: event.seq, monoNs: event.mono_ns, pid, rssKB: fields.rss_kb, footprintKB: fields.footprint_kb });
  }

  const callbacks = last.frames - first.frames;
  return {
    plugin,
    window,
    pid,
    timeOrigin: first.timeOrigin,
    callbacks,
    elapsedMs,
    framesPerSecond: callbacks * 1000 / elapsedMs,
    sampler,
  };
}
