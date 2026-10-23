// Measurement failures use a controlled clock and draw module, so unit tests have no performance assertion.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const benchmarkUrl = new URL("../benchmark/declared-ui.mjs", import.meta.url);
async function benchmark() {
  assert.ok(existsSync(benchmarkUrl), "the dedicated declared UI benchmark is missing");
  return import(benchmarkUrl.href);
}

function fixture({ kind = "list", elapsed = 500, missing = 0, omitBindings = false, failure } = {}) {
  const lines = [];
  const calls = [];
  let count = 0;
  let times = [100, 100 + elapsed];
  const body = { querySelectorAll: () => ({ length: count - missing }) };
  return {
    lines, calls,
    options: {
      kind,
      document: { createElement: () => body },
      now: () => { calls.push("clock"); return times.shift(); },
      write: (line) => lines.push(line),
      module: {
        validateValue(value, options) {
          calls.push("validate");
          assert.equal(options.owner, "demo");
          assert.equal(options.declared("demo.open"), true);
          if (failure) throw failure;
          return value;
        },
        drawValue(actualBody, elements, { bind, expandedByTree }) {
          calls.push("draw");
          assert.equal(actualBody, body);
          const element = elements[0];
          if (kind === "list") {
            count = element.items.length;
            if (!omitBindings) for (const item of element.items) bind({}, item.command);
          } else {
            const visit = (nodes, parent = []) => {
              for (const node of nodes) {
                count += 1;
                if (!node.children?.length) continue;
                const path = [...parent, node.key];
                assert.equal(expandedByTree.get(element.key).get(JSON.stringify(path)), true);
                if (!omitBindings) bind({}, "core.declared-ui.tree.expand");
                visit(node.children, path);
              }
            };
            visit(element.nodes);
            if (!omitBindings) { bind({}, "core.declared-ui.tree.move"); bind({}, "core.declared-ui.tree.expand"); }
          }
        },
      },
    },
  };
}

for (const [kind, count, bound] of [["tree", 5000, 2000], ["list", 1000, 500]]) {
  test(`${kind} records complete validation and drawing at its existing bound`, { timeout: 5000 }, async () => {
    const { runCase } = await benchmark();
    const run = fixture({ kind, elapsed: bound });
    const result = runCase(run.options);
    assert.deepEqual(run.calls, ["clock", "validate", "draw", "clock"]);
    assert.equal(result.count, count);
    assert.equal(result.elapsedMs, bound);
    assert.equal(result.boundMs, bound);
    assert.equal(result.passed, true);
    assert.ok(result.bindings > 0);
    if (kind === "tree") assert.equal(result.levels, 16);
    assert.deepEqual(JSON.parse(run.lines[0]), result);
    assert.match(result.environment.packageVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(result.environment.nodeVersion, process.version);
    assert.match(result.environment.jsdomVersion, /^\d+\./);
    assert.equal(result.environment.platform, process.platform);
    assert.equal(result.environment.arch, process.arch);
    assert.ok(result.environment.osRelease.length > 0);
    assert.ok(result.environment.cpu.length > 0);
    assert.ok(result.environment.cpuCount > 0);
    assert.equal(result.environment.loadAverage.length, 3);
    assert.ok(result.environment.loadAverage.every(Number.isFinite));
  });

  test(`${kind} reports a bound failure with its measurement`, { timeout: 5000 }, async () => {
    const { runCase } = await benchmark();
    const run = fixture({ kind, elapsed: bound + 1 });
    assert.throws(() => runCase(run.options), new RegExp(`${kind}.*${bound + 1}.*${bound}`));
    assert.equal(JSON.parse(run.lines[0]).passed, false);
    assert.equal(JSON.parse(run.lines[0]).elapsedMs, bound + 1);
  });

  test(`${kind} refuses an incomplete draw instead of timing less work`, { timeout: 5000 }, async () => {
    const { runCase } = await benchmark();
    const run = fixture({ kind, missing: 1 });
    assert.throws(() => runCase(run.options), new RegExp(`${kind} drew ${count - 1} of ${count}`));
    assert.deepEqual(run.lines, []);
  });
}

test("a complete draw without bindings fails the measurement", { timeout: 5000 }, async () => {
  const { runCase } = await benchmark();
  const run = fixture({ omitBindings: true });
  assert.throws(() => runCase(run.options), /list bound 0 of 1000/);
  assert.deepEqual(run.lines, []);
});

test("nonfinite and reversed clock readings fail the measurement", { timeout: 5000 }, async () => {
  const { runCase } = await benchmark();
  for (const elapsed of [NaN, Infinity, -1]) {
    const run = fixture({ elapsed });
    assert.throws(() => runCase(run.options), /invalid clock readings/);
    assert.deepEqual(run.lines, []);
  }
});

test("validation and drawing errors retain their original cause", { timeout: 5000 }, async () => {
  const { runCase } = await benchmark();
  const failure = new Error("validation refused the value");
  const run = fixture({ failure });
  assert.throws(() => runCase(run.options), (error) => error === failure);
  run.options.module.validateValue = (value) => value;
  run.options.module.drawValue = () => { throw failure; };
  assert.throws(() => runCase(run.options), (error) => error === failure);
  assert.deepEqual(run.lines, []);
});

test("an unknown case fails before drawing", { timeout: 5000 }, async () => {
  const { runCase } = await benchmark();
  const run = fixture({ kind: "unknown" });
  assert.throws(() => runCase(run.options), /unknown declared UI benchmark case: unknown/);
  assert.deepEqual(run.calls, []);
});
