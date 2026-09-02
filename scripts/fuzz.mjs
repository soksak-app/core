/**
 * Random operation sequences, every invariant checked after each one.
 *
 * The test suite states what should happen. This asks whether anything the
 * suite did not think of breaks the rules, by driving the API the way a host
 * would and reading the plane after every step.
 *
 *   node scripts/fuzz.mjs [seeds] [steps]
 *
 * Exits non-zero on the first seed that fails, with the operations that led
 * there, so the failure can be pasted into a test.
 */
import { Soksak } from "../dist/index.js";

const SEEDS = Number(process.argv[2] ?? 400);
const STEPS = Number(process.argv[3] ?? 120);
const SIDES = ["left", "right", "top", "bottom"];

const mulberry = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Every rule the README states, read off the plane as drawn. */
function check(grid, where) {
  const errs = [];
  const rects = [...grid.rects()];

  for (const [id, r] of rects) {
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.w) || !Number.isFinite(r.h)) {
      errs.push(`${where}: ${id} is ${r.x},${r.y} ${r.w}x${r.h}`);
    }
    if (r.w < -1e-6 || r.h < -1e-6) errs.push(`${where}: ${id} is inside out at ${r.w}x${r.h}`);
    if (r.x < -1e-6 || r.y < -1e-6) errs.push(`${where}: ${id} starts at ${r.x},${r.y}`);
    if (r.x + r.w > grid.width + 1e-6) errs.push(`${where}: ${id} runs past the plane's width`);
    if (r.y + r.h > grid.height + 1e-6) errs.push(`${where}: ${id} runs past the plane's height`);
  }

  for (const axis of ["x", "y"]) {
    const a = grid.lines(axis);
    if (a[0] !== 0 || a[a.length - 1] !== 1) errs.push(`${where}: ${axis} does not run 0..1`);
    for (let k = 1; k < a.length; k++) {
      if (!(a[k] >= a[k - 1] - 1e-9)) errs.push(`${where}: ${axis} line ${k} is before ${k - 1}`);
      if (a[k] < -1e-9 || a[k] > 1 + 1e-9) errs.push(`${where}: ${axis} line ${k} is outside 0..1`);
    }
  }

  if (!grid.isSlicing()) errs.push(`${where}: the arrangement is not reachable by splitting`);
  if (new Set(rects.map(([id]) => id)).size !== rects.length) errs.push(`${where}: two cards share a name`);

  // R5: two cards that meet at a line are drawn one corridor apart. Which
  // cards meet is read from the spans, not guessed from the pixels — a card
  // between two others in the same rows is invisible to a pixel test once it
  // is drawn with no width. A plane too narrow for one gap per line draws
  // every corridor narrower together, so what must hold is that they agree.
  const box = new Map(rects);
  for (const [axis, near, far, lo, hi, clo, chi] of [
    ["x", "x", "w", "c0", "c1", "r0", "r1"],
    ["y", "y", "h", "r0", "r1", "c0", "c1"],
  ]) {
    const gaps = new Map();
    for (const a of grid.cards) {
      for (const b of grid.cards) {
        if (a.id === b.id || b[lo] !== a[hi]) continue;               // they do not meet
        if (b[chi] <= a[clo] || b[clo] >= a[chi]) continue;           // not in the same rows
        const ra = box.get(a.id);
        const rb = box.get(b.id);
        // A card drawn with no width sits inside a corridor rather than
        // beside one, so the distance to it is not a corridor to compare.
        if (ra[far] <= 1e-9 || rb[far] <= 1e-9) continue;
        if (!gaps.has(a[hi])) gaps.set(a[hi], []);
        gaps.get(a[hi]).push([`${a.id}|${b.id}`, rb[near] - (ra[near] + ra[far])]);
      }
    }
    // Grouped by the line they meet at: one line's corridor is one number, and
    // a line no card reads charges nothing, so two lines may differ.
    for (const [line, at] of gaps) {
      const [firstPair, first] = at[0];
      for (const [pair, between] of at) {
        if (between < -1e-6) errs.push(`${where}: ${pair} overlap by ${(-between).toFixed(3)}`);
        if (between > grid.gap + 1e-6) {
          errs.push(`${where}: ${axis}${line} corridor ${between.toFixed(3)} > gap ${grid.gap}`);
        }
        if (Math.abs(between - first) > 1e-6) {
          errs.push(
            `${where}: ${axis}${line} ${pair} ${between.toFixed(3)} but ${firstPair} ${first.toFixed(3)}`,
          );
        }
      }
    }
  }
  return errs;
}

function run(seed, steps) {
  const rnd = mulberry(seed);
  const grid = new Soksak(undefined, {
    width: 200 + Math.floor(rnd() * 1600),
    height: 150 + Math.floor(rnd() * 1000),
    gap: Math.floor(rnd() * 40),
    minSize: Math.floor(rnd() * 120),
    snap: rnd() < 0.8 ? "merge" : "off",
    fillOrder: rnd() < 0.5 ? "v" : "h",
  });
  const ids = ["card"];
  const log = [];
  let made = 0;

  for (let s = 0; s < steps; s++) {
    const pick = () => ids[Math.floor(rnd() * ids.length)];
    const axis = rnd() < 0.5 ? "x" : "y";
    const k = rnd();
    const before = process.env.DUMP ? grid.toJSON() : null;
    let desc;
    try {
      if (k < 0.24) {
        const t = pick();
        const id = `n${made++}`;
        desc = `split(${JSON.stringify(t)}, ${JSON.stringify(axis)}, { id: ${JSON.stringify(id)} })`;
        if (grid.split(t, axis, { id })) ids.push(id);
      } else if (k < 0.34) {
        const t = pick();
        const side = SIDES[Math.floor(rnd() * 4)];
        const id = `n${made++}`;
        desc = `splitToward(${JSON.stringify(t)}, ${JSON.stringify(side)}, { id: ${JSON.stringify(id)} })`;
        if (grid.splitToward(t, side, { id })) ids.push(id);
      } else if (k < 0.44) {
        const line = Math.floor(rnd() * (grid.lines(axis).length + 1));
        const size = Math.floor(rnd() * 400);
        const id = `n${made++}`;
        desc = `insertAt(${JSON.stringify(axis)}, ${line}, { size: ${size}, id: ${JSON.stringify(id)} })`;
        if (grid.insertAt(axis, line, { size, id })) ids.push(id);
      } else if (k < 0.56 && ids.length > 1) {
        const t = pick();
        desc = `close(${JSON.stringify(t)})`;
        if (grid.close(t)) ids.splice(ids.indexOf(t), 1);
      } else if (k < 0.64) {
        const t = pick();
        const to = pick();
        const side = SIDES[Math.floor(rnd() * 4)];
        desc = `move(${JSON.stringify(t)}, ${JSON.stringify(to)}, ${JSON.stringify(side)})`;
        grid.move(t, to, side);
      } else if (k < 0.72) {
        const t = pick();
        const line = Math.floor(rnd() * grid.lines(axis).length);
        desc = `moveTo(${JSON.stringify(t)}, ${JSON.stringify(axis)}, ${line})`;
        grid.moveTo(t, axis, line);
      } else if (k < 0.82) {
        const line = Math.floor(rnd() * grid.lines(axis).length);
        const px = Math.round(rnd() * grid.width);
        desc = `moveBoundary(${JSON.stringify(axis)}, ${line}, ${px})`;
        grid.moveBoundary(axis, line, px);
      } else if (k < 0.87) {
        const line = Math.floor(rnd() * grid.lines(axis).length);
        desc = `mergeCoincident(${JSON.stringify(axis)}, ${line})`;
        grid.mergeCoincident(axis, line);
      } else if (k < 0.94) {
        const t = pick();
        const px = rnd() < 0.3 ? null : Math.floor(rnd() * 400);
        desc = `setSize(${JSON.stringify(t)}, ${JSON.stringify(axis)}, ${px})`;
        grid.setSize(t, axis, px);
      } else if (k < 0.97) {
        const t = pick();
        const on = rnd() < 0.5;
        desc = `setFixed(${JSON.stringify(t)}, ${on})`;
        grid.setFixed(t, on);
      } else {
        const w = 100 + Math.floor(rnd() * 1600);
        const h = 100 + Math.floor(rnd() * 900);
        desc = `resize(${w}, ${h})`;
        grid.resize(w, h);
      }
    } catch (e) {
      log.push(desc);
      return { seed, log, errs: [`${desc} threw: ${e && e.message}`] };
    }
    log.push(desc);
    const errs = check(grid, `step ${s} after ${desc}`);
    if (errs.length) {
      if (process.env.DUMP) console.error(`DUMP ${JSON.stringify({ before, w: grid.width, h: grid.height, gap: grid.gap, min: grid.minSize, op: desc })}`);
      return { seed, log, errs };
    }
  }
  return null;
}

let failures = 0;
const classes = new Set();
for (let seed = 1; seed <= SEEDS; seed++) {
  const bad = run(seed, STEPS);
  if (!bad) continue;
  failures++;
  const kind = bad.errs[0].replace(/step \d+ after [^:]+: /, "").replace(/[\d.]+/g, "#");
  if (!classes.has(kind)) {
    classes.add(kind);
    console.log(`--- seed ${bad.seed} (${bad.log.length} ops) ---`);
    for (const e of bad.errs.slice(0, 4)) console.log(e);
    for (const line of bad.log.slice(-8)) console.log(`  ${line}`);
    console.log();
  }
}
console.log(`${failures}/${SEEDS} seeds failed, ${classes.size} distinct classes`);
process.exit(failures ? 1 : 0);
