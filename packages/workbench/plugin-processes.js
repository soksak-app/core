// Core statuses of the plugin processes (docs/plans/plugin-processes.md, rules 2, 3 and 6). Each status holds a list of records
// that carry the plugin id. The call layer of a plugin process reports its open calls and its losses through callReporter
// (F212.3-1); the declared UI snapshots (F212.3-2) and the presentation and responsiveness of views (F212.7) fill the others.
//
// core-exposure.js registers each reader under the name that exposure.json declares.

import { trace } from "./performance.js";

/** The losses of each plugin, in the order of their first count. */
const lossCounts = new Map();
/** The open calls of each call layer. A layer with no open call is removed. */
const layers = new Map();
const listeners = new Set();
/** The responsiveness of each view surface, in the order of its first notice. */
const viewStates = [];

const announce = () => {
  for (const listener of listeners) listener();
};

const lossesOf = (plugin) => {
  if (!lossCounts.has(plugin)) {
    lossCounts.set(plugin, { plugin, skipped: 0, stalled: 0, abandoned: 0, lateReplies: 0, timeouts: 0, peerLost: 0 });
  }
  return lossCounts.get(plugin);
};

/** Calls fn after each change of a plugin process status. Returns the function that removes the listener. */
export function onPluginProcessChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Returns the report function of one call layer (createCalls of @soksak/plugin-api). Each call of callReporter makes a new layer,
 * so the open calls of the layers of one plugin add up in openCalls.
 *
 * A timeout counts losses.timeouts, a late reply counts losses.lateReplies, and a surface that closed with a call open counts
 * losses.peerLost. A process or sidecar that ends with a call open is a failure: no loss is counted, and the host relay writes
 * it as an error event.
 */
export function callReporter(plugin) {
  const layer = {};
  return (event) => {
    if (event.kind === "open-calls") {
      if (event.count === 0) layers.delete(layer);
      else layers.set(layer, { plugin, count: event.count, oldestStartedAt: event.oldestStartedAt });
    } else if (event.kind === "timeout") {
      lossesOf(plugin).timeouts += 1;
    } else if (event.kind === "late-reply") {
      lossesOf(plugin).lateReplies += 1;
    } else if (event.kind === "peer-lost") {
      if (event.reason === "surface-closed") lossesOf(plugin).peerLost += 1;
    } else {
      throw new TypeError(`unknown call report kind ${event.kind}`);
    }
    announce();
  };
}

/**
 * Returns the report function of one declared UI snapshot channel (createSnapshotSender of @soksak/plugin-api). A value that a
 * newer value overwrites counts losses.skipped, and a stall counts losses.stalled.
 */
export function snapshotReporter(plugin) {
  return (event) => {
    const entry = lossesOf(plugin);
    // The page writes each event through the page trace while the trace is on (docs/spec/performance-trace.md).
    if (event.kind === "skipped") {
      entry.skipped += event.count;
      trace("declared-ui.snapshot.skipped", { plugin, status: event.status, count: event.count });
    } else if (event.kind === "stalled") {
      // A stalled value is counted only: no live observer waits for its acknowledgement, so it writes no trace event.
      entry.stalled += event.count;
    } else {
      throw new TypeError(`unknown snapshot report kind ${event.kind}`);
    }
    announce();
  };
}

/** The open calls of each plugin that has one: `{plugin, count, oldestStartedAt}`. */
export const openCalls = () => {
  const totals = new Map();
  for (const { plugin, count, oldestStartedAt } of layers.values()) {
    // default: the first layer of a plugin starts its total at zero open calls.
    const total = totals.get(plugin) ?? { plugin, count: 0, oldestStartedAt: null };
    total.count += count;
    if (oldestStartedAt !== null && (total.oldestStartedAt === null || oldestStartedAt < total.oldestStartedAt)) {
      total.oldestStartedAt = oldestStartedAt;
    }
    totals.set(plugin, total);
  }
  return [...totals.values()];
};

/** The losses of each plugin that has counted one: `{plugin, skipped, stalled, abandoned, lateReplies, timeouts, peerLost}`. */
export const losses = () => [...lossCounts.values()].map((entry) => ({ ...entry }));

/** The responsiveness of each plugin view surface: `{plugin, surface, responsive}`. */
export const views = () => viewStates.map((entry) => ({ ...entry }));

/**
 * Records the responsiveness notice of the view of surface, which the host sends as view-responsiveness (docs/spec/native-surfaces.md#view-surfaces).
 * A notice whose responsive is not a boolean is refused.
 */
export function viewResponsiveness(plugin, surface, responsive) {
  if (typeof responsive !== "boolean") throw new TypeError(`view ${surface} responsive is not a boolean`);
  const entry = viewStates.find((state) => state.surface === surface);
  if (entry) entry.responsive = responsive;
  else viewStates.push({ plugin, surface, responsive });
  announce();
}

/** Removes the state of the view of surface when the surface is disposed. */
export function forgetView(surface) {
  const index = viewStates.findIndex((state) => state.surface === surface);
  if (index < 0) return;
  viewStates.splice(index, 1);
  announce();
}
