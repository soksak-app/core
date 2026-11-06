import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Soksak } from "../dist/index.js";
import { assertRoleIndependence } from "../scripts/layout-equivalence.mjs";
import { layoutCaseSeeds, makeLayoutCase } from "../scripts/layout-role-cases.mjs";
import { assertInvariants } from "../scripts/layout-sequences.mjs";
import { guillotine } from "./slicing-oracle.mjs";

const state = { xs: [0, 0.5, 1], ys: [0, 1], cards: [
  { id: "held", c0: 0, c1: 1, r0: 0, r1: 1, fixed: true },
  { id: "open", c0: 1, c1: 2, r0: 0, r1: 1 },
] };
const options = { width: 1000, height: 800 };

test("transformed sequences reject a refused operation that changes state", { timeout: 3000 }, () => {
  const operations = [{ method: "close", args: ["held"] }, { method: "setFixed", args: ["held", false] }];
  assert.throws(() => assertRoleIndependence({ state, options, operations, seed: 47, create(value, settings) {
    const grid = new Soksak(value, settings);
    const close = grid.close.bind(grid);
    grid.close = (id) => {
      const result = close(id);
      if (!result) grid.resize(grid.width - 1, grid.height);
      return result;
    };
    return grid;
  } }), (error) => {
    assert.equal(error.code, "ERR_ASSERTION");
    assert.match(error.message, /refused operation changed state/);
    assert.equal(error.layoutCase.seed, 47);
    assert.deepEqual(error.layoutCase.operations, operations);
    assert.ok(error.message.includes(JSON.stringify(operations)), "the failure output retains the complete call list");
    return true;
  });
});

test("explicit permutation selection bounds transformed sequence work", { timeout: 3000 }, () => {
  const result = assertRoleIndependence({ state, options, operations: [], orders: [[0, 1]] });
  assert.equal(result.variants, 1, "only the requested identity order and its renamed counterpart run");
  assert.throws(() => assertRoleIndependence({ state, options, operations: [], orders: [[0, 0]] }), /invalid permutation/);
});

function checkLayout(grid) {
  assert.doesNotThrow(() => assertInvariants(grid, "constrained"), "public layout invariants");
  assert.ok(guillotine(grid.cards), "independent slicing oracle rejected the spans");
}

test("varied layout cases cover the declared input classes and operation outcomes", { timeout: 30000 }, async (t) => {
  const observed = [];
  const methods = {};
  for (const seed of layoutCaseSeeds) await t.test(`seed ${seed}`, { timeout: 3000 }, () => {
    const value = makeLayoutCase(seed);
    assert.deepEqual(makeLayoutCase(seed), value, "seed reproduces the initial state and full trace");
    const { state, options } = value;
    const topology = state.xs.length === 2 ? "rows" : state.ys.length === 2 ? "columns" : "mixed";
    assert.equal(topology, value.topology);
    assert.equal(state.cards.length, [2, 3, 4, 5, 6, 7, 8, 2, 3, 4, 5, 6, 7, 8, 3, 3, 4, 5, 6, 7, 8][seed]);
    assert.equal(value.operations.length, 34);
    assert.ok(value.orders.length <= state.cards.length + 3);
    const initial = Soksak.from(state, options);
    checkLayout(initial);
    const result = assertRoleIndependence({ ...value, check: checkLayout });
    assert.equal(result.transitions.length, value.operations.length);
    assert.equal(result.counts.successful + result.counts.refused, value.operations.length);
    assert.deepEqual([1, 6, 7, 9, 11, 12].map((step) => result.transitions[step].outcome), ["refused", "successful", "successful", "refused", "successful", "successful"]);
    for (const [method, counts] of Object.entries(result.byMethod)) {
      const total = methods[method] ??= { successful: 0, refused: 0 };
      total.successful += counts.successful;
      total.refused += counts.refused;
    }
    observed.push({ seed, topology, cards: state.cards.length, ...options, ...result.counts, variants: result.variants,
      fixed: state.cards.filter((card) => card.fixed).length,
      sized: state.cards.filter((card) => card.width !== undefined || card.height !== undefined).length,
      zeroSize: [...initial.rects().values()].filter((rect) => rect.w === 0 || rect.h === 0).length,
    });
  });
  const unique = (key) => [...new Set(observed.map((entry) => entry[key]))].sort((a, b) => typeof a === "number" ? a - b : a.localeCompare(b));
  assert.deepEqual(unique("topology"), ["columns", "mixed", "rows"]);
  assert.deepEqual(unique("cards"), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(unique("width"), [320, 640, 1730]);
  assert.deepEqual(unique("height"), [180, 900, 1440]);
  assert.deepEqual(unique("gap"), [0, 17, 64]);
  assert.deepEqual(unique("minSize"), [24, 96, 160]);
  assert.deepEqual(unique("snap"), ["merge", "off"]);
  assert.deepEqual(unique("snapDistance"), [3, 29]);
  assert.deepEqual(unique("grabSize"), [7, 23]);
  assert.deepEqual(unique("fillOrder"), ["h", "v"]);
  for (const topology of unique("topology")) assert.equal(new Set(observed.filter((entry) => entry.topology === topology).map((entry) => entry.width)).size, 3);
  assert.ok(observed.some((entry) => entry.fixed > 0) && observed.some((entry) => entry.sized > 0));
  assert.ok(observed.some((entry) => entry.zeroSize > 0) && observed.some((entry) => entry.zeroSize === 0));
  for (const method of ["split", "splitToward", "close", "move", "insertAt", "moveTo", "setSize"]) {
    assert.ok(methods[method]?.successful > 0 && methods[method]?.refused > 0, `${method}: ${JSON.stringify(methods[method])}`);
  }
  t.diagnostic(`input classes ${JSON.stringify(observed)}`);
  t.diagnostic(`operation outcomes ${JSON.stringify(methods)}`);
});

test("layout option changes affect geometry and refusal decisions", { timeout: 3000 }, () => {
  const plain = new Soksak(undefined, { width: 320, height: 180, gap: 0, minSize: 24 });
  const crowded = new Soksak(undefined, { width: 320, height: 180, gap: 64, minSize: 160 });
  assert.equal(plain.split("card", "x", { id: "other" }), "other");
  assert.equal(crowded.split("card", "x", { id: "other" }), null);
  const before = plain.rect("card").w;
  plain.gap = 64;
  assert.ok(plain.rect("card").w < before);
  const square = { xs: [0, 0.5, 1], ys: [0, 0.5, 1], cards: [
    { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 }, { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
    { id: "c", c0: 0, c1: 1, r0: 1, r1: 2 }, { id: "d", c0: 1, c1: 2, r0: 1, r1: 2 },
  ] };
  const vertical = new Soksak(square, { width: 1000, height: 800, fillOrder: "v" });
  const horizontal = new Soksak(square, { width: 1000, height: 800, fillOrder: "h" });
  assert.equal(vertical.close("a"), true);
  assert.equal(horizontal.close("a"), true);
  assert.notDeepEqual(vertical.rect("b"), horizontal.rect("b"));
  const virtual = { xs: [0, 0.5, 0.75, 1], ys: [0, 0.5, 1], cards: [
    { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
    { id: "b", c0: 1, c1: 3, r0: 0, r1: 1 },
    { id: "under", c0: 0, c1: 3, r0: 1, r1: 2 },
  ] };
  for (const [snap, snapDistance, expected] of [["merge", 29, 240], ["merge", 3, 220], ["off", 29, 220]]) {
    const grid = new Soksak(virtual, { width: 320, height: 180, gap: 0, minSize: 24, snap, snapDistance, grabSize: 23 });
    assert.equal(grid.dividers().find((divider) => divider.axis === "x").w, 23);
    grid.grabSize = 7;
    assert.equal(grid.dividers().find((divider) => divider.axis === "x").w, 7);
    assert.equal(grid.moveBoundary("x", 1, 220), expected);
  }
});

test("varied layout checks reject ID, array-order and size implementation mutants", { timeout: 20000 }, async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const value = makeLayoutCase(0);
  checkLayout(Soksak.from(value.state, value.options));
  assert.doesNotThrow(() => assertRoleIndependence({ ...value, check: checkLayout }));
  const mutants = [
    { name: "identifier", file: "soksak.js", find: "return card && this.rectOf(card);", to: "const r = card && this.rectOf(card); return r && this.w < 400 && this.h >= 180 && id === 'card' ? { ...r, x: r.x + 1 } : r;", error: /role independence/ },
    { name: "array order", file: "soksak.js", find: "return card && this.rectOf(card);", to: "const r = card && this.rectOf(card); return r && this.w < 400 && this.h >= 180 && card === this.list[0] ? { ...r, x: r.x + 1 } : r;", error: /role independence/ },
    { name: "size", file: "geometry.js", find: "    return { x, y, w, h };", to: "    return { x, y, w: frame.x.at.at(-1) < 400 && frame.y.at.at(-1) >= 180 ? -1 : w, h };", error: /public layout invariants/ },
  ];
  for (const mutant of mutants) await t.test(mutant.name, { timeout: 5000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "soksak-layout-case-mutant-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await cp(join(root, "dist"), join(directory, "dist"), { recursive: true });
    await mkdir(join(directory, "test"));
    await mkdir(join(directory, "scripts"));
    for (const file of ["rules.test.mjs", "helpers.mjs", "slicing-oracle.mjs"]) await cp(join(root, "test", file), join(directory, "test", file));
    for (const file of ["layout-sequences.mjs", "layout-equivalence.mjs"]) await cp(join(root, "scripts", file), join(directory, "scripts", file));
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    const path = join(directory, "dist", mutant.file);
    const source = await readFile(path, "utf8");
    assert.equal(source.split(mutant.find).length - 1, 1, `${mutant.name}: mutation anchor must be unique`);
    await writeFile(path, source.replace(mutant.find, mutant.to));
    // The actual existing R2 test must still pass in this mutated implementation.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const legacy = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^R2", "test/rules.test.mjs"], { cwd: directory, timeout: 3500, env });
    assert.match(legacy.stdout, /^ok \d+ - R2 — identifiers and card order do not determine layout behavior$/m, "the legacy control owns an executed passing test");
    assert.match(legacy.stdout, /^# tests 1$/m);
    assert.match(legacy.stdout, /^# pass 1$/m);
    const { Soksak: Mutated } = await import(pathToFileURL(join(directory, "dist/index.js")).href);
    assert.throws(() => assertRoleIndependence({ ...value, check: checkLayout, create: (state, options) => new Mutated(state, options) }), (error) => {
      assert.equal(error.code, "ERR_ASSERTION", "module or environment errors are not detection");
      assert.match(error.message, mutant.error);
      assert.deepEqual(error.layoutCase.state, value.state);
      assert.deepEqual(error.layoutCase.operations, value.operations);
      assert.equal(error.layoutCase.seed, value.seed);
      return true;
    });
  });
});
