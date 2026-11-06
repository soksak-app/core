import assert from "node:assert/strict";
import { Soksak } from "../dist/index.js";

export const W = 1600;
export const H = 1200;
const sides = ["left", "right", "top", "bottom"];
export const ordinaryOperations = ["split", "close", "tidy", "moveBoundary", "mergeCoincident"];
export const fixedOperations = ["splitToward", "close", "move", "insertAt", "moveTo", "moveBoundary"];
export const allOperations = [...new Set([...ordinaryOperations, ...fixedOperations, "setSize", "setFixed", "resize"])];
export const operationWeights = {
  ordinary: { split: 50, close: 20, tidy: 5, moveBoundary: 25 },
  fixed: { splitToward: 30, close: 20, move: 25, insertAt: 5, moveTo: 8, moveBoundary: 12 },
  constrained: { split: 24, splitToward: 10, insertAt: 10, close: 12, move: 8, moveTo: 8, moveBoundary: 10, mergeCoincident: 5, setSize: 7, setFixed: 3, resize: 3 },
};

/** One seeded generator serves all profiles; values are always below one. */
export function random(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createProfile(profile, seed = 0) {
  const next = random(seed);
  if (profile === "ordinary") return new Soksak(undefined, { width: W, height: H });
  if (profile === "fixed") return new Soksak({
    xs: [0, 0.18, 0.36, 0.8, 1], ys: [0, 0.5, 1],
    cards: [
      { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, width: 180, fixed: true },
      { id: "rail", c0: 1, c1: 2, r0: 0, r1: 2, width: 190, fixed: true },
      { id: "upper", c0: 2, c1: 3, r0: 0, r1: 1 },
      { id: "lower", c0: 2, c1: 3, r0: 1, r1: 2 },
      { id: "right", c0: 3, c1: 4, r0: 0, r1: 2, width: 200, fixed: true },
    ],
  }, { width: W, height: H });
  if (profile === "constrained") return new Soksak(undefined, {
    width: 200 + Math.floor(next() * 1600), height: 150 + Math.floor(next() * 1000),
    gap: Math.floor(next() * 40), minSize: Math.floor(next() * 120),
    snap: next() < 0.8 ? "merge" : "off", fillOrder: next() < 0.5 ? "v" : "h",
  });
  throw new Error(`unknown layout profile: ${profile}`);
}

function requireInvariant(condition, invariant, detail) {
  if (condition) return;
  const error = new Error(`${invariant}: ${detail}`);
  error.invariant = invariant;
  throw error;
}

/** Public geometry and integer spans, independent of operation generation. */
export function assertInvariants(grid, profile = "constrained") {
  const require = requireInvariant;
  const cards = grid.cards;
  const rects = grid.rects();
  require(new Set(cards.map((c) => c.id)).size === cards.length, "unique-ids", "duplicate card");
  for (const axis of ["x", "y"]) {
    const lines = grid.lines(axis);
    require(lines[0] === 0 && lines.at(-1) === 1, "line-endpoints", axis);
    require(lines.every((v, i) => Number.isFinite(v) && v >= 0 && v <= 1 && (!i || v >= lines[i - 1])), "line-order", axis);
  }
  for (const c of cards) {
    const r = rects.get(c.id);
    require(r && [r.x, r.y, r.w, r.h].every(Number.isFinite), "rect-finite", c.id);
    require(r.w >= -1e-6 && r.h >= -1e-6, "rect-size", c.id);
    require(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= grid.width + 1e-6 && r.y + r.h <= grid.height + 1e-6, "rect-bounds", c.id);
    require([c.c0, c.c1, c.r0, c.r1].every(Number.isInteger) && c.c0 >= 0 && c.r0 >= 0 && c.c0 < c.c1 && c.r0 < c.r1 && c.c1 < grid.lines("x").length && c.r1 < grid.lines("y").length, "card-span", c.id);
    if (profile === "ordinary") require(Math.min(r.w, r.h) >= grid.minSize - 0.6, "minimum-size", c.id);
    if (profile === "fixed") require(r.w > 0 && r.h > 0, "positive-area", c.id);
  }
  // Counting owners of every integer cell catches a hole paired with an overlap,
  // which a total-area assertion alone cannot distinguish.
  for (let x = 0; x < grid.lines("x").length - 1; x++) {
    for (let y = 0; y < grid.lines("y").length - 1; y++) {
      require(cards.filter((c) => c.c0 <= x && c.c1 > x && c.r0 <= y && c.r1 > y).length === 1, "slot-coverage", `${x},${y}`);
    }
  }
  const area = cards.reduce((sum, c) => sum + (grid.boundaryPos("x", c.c1) - grid.boundaryPos("x", c.c0)) * (grid.boundaryPos("y", c.r1) - grid.boundaryPos("y", c.r0)), 0);
  require(Math.abs(area - grid.width * grid.height) < 2, "plane-coverage", String(area));
  const boxes = [...rects.values()];
  let closest = Infinity;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const dx = Math.max(b.x - a.x - a.w, a.x - b.x - b.w);
    const dy = Math.max(b.y - a.y - a.h, a.y - b.y - b.h);
    require(dx > -0.01 || dy > -0.01, "rect-overlap", `${i},${j}`);
    closest = Math.min(closest, Math.max(dx, dy));
  }
  if (profile !== "constrained" && boxes.length > 1) require(Math.abs(closest - grid.gap) < 0.5, "corridor-size", String(closest));
  for (const [axis, near, size, lo, hi, clo, chi] of [
    ["x", "x", "w", "c0", "c1", "r0", "r1"], ["y", "y", "h", "r0", "r1", "c0", "c1"],
  ]) {
    const gaps = new Map();
    for (const a of cards) for (const b of cards) {
      if (a.id === b.id || b[lo] !== a[hi] || b[chi] <= a[clo] || b[clo] >= a[chi]) continue;
      const ra = rects.get(a.id), rb = rects.get(b.id);
      if (ra[size] <= 1e-9 || rb[size] <= 1e-9) continue;
      const gap = rb[near] - ra[near] - ra[size];
      require(gap >= -1e-6 && gap <= grid.gap + 1e-6, "corridor-bounds", `${axis}${a[hi]}: ${gap}`);
      if (gaps.has(a[hi])) require(Math.abs(gaps.get(a[hi]) - gap) < 1e-6, "corridor-agreement", `${axis}${a[hi]}`);
      gaps.set(a[hi], gap);
    }
    if (profile === "fixed") {
      const asked = axis === "x" ? "width" : "height";
      const ratios = cards.filter((c) => c[hi] - c[lo] === 1 && c[asked] > 0.01).map((c) => rects.get(c.id)[size] / c[asked]);
      if (ratios.length) require(Math.max(...ratios) - Math.min(...ratios) < 0.001, "fixed-size-ratio", axis);
    }
  }
  require(grid.isSlicing(), "slicing", "arrangement is not slicing");
  if (profile === "fixed") {
    const open = cards.filter((c) => !c.fixed);
    if (open.length > 1) require(open.some((c) => grid.canClose(c.id)), "closable-card", "no open card can close");
    for (const c of open) {
      const trial = Soksak.from(grid.toJSON(), { width: grid.width, height: grid.height });
      require(trial.close(c.id) === grid.canClose(c.id), "close-prediction", c.id);
    }
  }
}

/** Generate serializable public calls, including legitimate refusals. */
export function generateOperation(grid, next, step, { profile = "ordinary", methods } = {}) {
  const pick = (values) => values[Math.floor(next() * values.length)];
  let method;
  if (methods) method = pick(methods);
  else {
    let roll = next() * 100;
    for (const [name, weight] of Object.entries(operationWeights[profile])) {
      roll -= weight;
      if (roll < 0) { method = name; break; }
    }
  }
  const open = grid.cards.filter((c) => !c.fixed);
  const candidates = profile === "constrained" || !open.length ? grid.cards : open;
  const id = () => pick(candidates).id;
  const axis = next() < 0.5 ? "x" : "y";
  const line = () => Math.floor(next() * grid.lines(axis).length);
  let born = `generated-${step}`;
  while (grid.card(born)) born += "-new";
  let args;
  switch (method) {
    case "split": args = [id(), axis, { id: born }]; break;
    case "splitToward": args = [id(), pick(sides), { id: born, data: { n: step } }]; break;
    case "close": args = [id()]; break;
    case "tidy": args = []; break;
    case "move": args = [id(), id(), pick(sides)]; break;
    case "insertAt": args = [axis, profile === "constrained" ? Math.floor(next() * (grid.lines(axis).length + 1)) : pick(grid.standings(axis)), { id: born, size: profile === "fixed" ? 40 + Math.floor(next() * 120) : Math.floor(next() * 400) }]; break;
    case "moveTo": args = profile === "fixed" ? ["rail", "x", pick(grid.standings("x"))] : [id(), axis, line()]; break;
    case "moveBoundary": {
      if (profile === "constrained") { args = [axis, line(), Math.round(next() * (axis === "x" ? grid.width : grid.height))]; break; }
      const divider = pick(grid.dividers());
      args = divider ? [divider.axis, divider.line, grid.boundaryPos(divider.axis, divider.line) + (next() - 0.5) * 0.4 * (divider.axis === "x" ? grid.width : grid.height)] : [axis, 0, 0];
      break;
    }
    case "mergeCoincident": args = [axis, line()]; break;
    case "setSize": args = [id(), axis, next() < 0.3 ? null : Math.floor(next() * 400)]; break;
    case "setFixed": args = [id(), next() < 0.5]; break;
    case "resize": args = [Math.floor(next() * 1700), Math.floor(next() * 1000)]; break;
    default: throw new Error(`unknown layout operation: ${method}`);
  }
  return { method, args };
}

/** A refusal is a null/false return; a successful no-op is counted separately. */
export function runSequence(grid, { seed = 0, steps = 0, profile = "ordinary", methods, operations, check = assertInvariants, afterOperation } = {}) {
  const next = random(seed);
  const initial = structuredClone({ state: grid.toJSON(), options: { width: grid.width, height: grid.height, gap: grid.gap, minSize: grid.minSize, snap: grid.snap, snapDistance: grid.snapDistance, grabSize: grid.grabSize, fillOrder: grid.fillOrder } });
  const counts = () => ({ successful: 0, refused: 0, changed: 0, unchanged: 0 });
  const report = { seed, profile, initial, trace: [], counts: counts(), byMethod: {}, failure: null };
  const inspect = () => check(grid, profile);
  try { inspect(); } catch (error) {
    report.failure = { invariant: error.invariant ?? "assertion", message: error.message, step: -1 };
    return report;
  }
  sequence: for (let step = 0; step < (operations?.length ?? steps); step++) {
    const selected = operations?.[step] ?? generateOperation(grid, next, step, { profile, methods });
    // Ordinary drags retain their original follow-up merge, audited separately.
    const calls = !operations && !methods && profile === "ordinary" && selected.method === "moveBoundary"
      ? [selected, { method: "mergeCoincident", args: selected.args.slice(0, 2) }] : [selected];
    for (const call of calls) {
      const operation = structuredClone({ method: call.method, args: call.args });
      const before = JSON.stringify({ state: grid.toJSON(), width: grid.width, height: grid.height });
      const entry = { ...operation };
      report.trace.push(entry);
      const methodCounts = report.byMethod[operation.method] ??= counts();
      try {
        const result = grid[operation.method](...operation.args);
        entry.result = result;
        entry.outcome = result === false || result === null ? "refused" : "successful";
        report.counts[entry.outcome]++;
        methodCounts[entry.outcome]++;
        const after = JSON.stringify({ state: grid.toJSON(), width: grid.width, height: grid.height });
        entry.changed = before !== after;
        report.counts[entry.changed ? "changed" : "unchanged"]++;
        methodCounts[entry.changed ? "changed" : "unchanged"]++;
        requireInvariant(entry.outcome !== "refused" || !entry.changed, "refusal-state", operation.method);
        inspect();
        afterOperation?.(grid, entry, report.trace.length - 1);
      } catch (error) {
        report.failure = { invariant: error.invariant ?? (entry.outcome ? "assertion" : `operation:${operation.method}`), message: error.message, step: report.trace.length - 1 };
        break sequence;
      }
    }
  }
  return report;
}

export function assertSequence(report) {
  assert.equal(report.failure, null, JSON.stringify(report));
  return report;
}

export function replaySequence(report, operations = report.trace, { create = ({ state, options }) => Soksak.from(state, options), check = assertInvariants } = {}) {
  return runSequence(create(structuredClone(report.initial)), {
    seed: report.seed, profile: report.profile, operations, check,
  });
}

/**
 * Generic value shrinkers do not supply the recorded-call replay contract:
 * retain the original evidence and accept only the same named invariant.
 * Deterministic chunk deletion gives a one-operation-minimal failing trace;
 * it does not claim the shortest possible trace or shrink argument values.
 */
export function reduceSequence(report, options = {}) {
  if (!report.failure) throw new Error("cannot reduce a passing sequence");
  const invariant = report.failure.invariant;
  if (!invariant || invariant === "assertion" || invariant.startsWith("operation:")) {
    throw new Error("reduction requires a named invariant; unclassified assertions and operation errors retain their original trace");
  }
  const original = structuredClone(report);
  let reduced = replaySequence(original, original.trace, options);
  if (reduced.failure?.invariant !== invariant) throw new Error(`original sequence does not reproduce ${invariant}`);
  let attempts = 1;
  let chunks = 2;
  while (reduced.trace.length) {
    const size = Math.ceil(reduced.trace.length / chunks);
    let accepted = false;
    for (let start = 0; start < reduced.trace.length; start += size) {
      const candidate = reduced.trace.slice(0, start).concat(reduced.trace.slice(start + size));
      const replayed = replaySequence(original, candidate, options);
      attempts++;
      if (replayed.failure?.invariant !== invariant) continue;
      reduced = replayed;
      chunks = Math.max(2, chunks - 1);
      accepted = true;
      break;
    }
    if (accepted) continue;
    if (chunks >= reduced.trace.length) break;
    chunks = Math.min(reduced.trace.length, chunks * 2);
  }
  return { original, reduced, attempts };
}
