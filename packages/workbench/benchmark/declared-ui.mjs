// Measures the declared UI construction limits without layout or paint (docs/spec/declared-ui.md#drawing-benchmark).
// The command supervisor gives each case its own process and hang limit; the measured bound is enforced here.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, loadavg, release } from "node:os";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const jsdomVersion = JSON.parse(readFileSync(require.resolve("jsdom/package.json"), "utf8")).version;
const CASES = {
  tree: { count: 5000, levels: 16, boundMs: 2000, selector: ".declared-node" },
  list: { count: 1000, boundMs: 500, selector: ".declared-row" },
};
const OPTIONS = { owner: "demo", declared: () => true, hasIcon: () => false };

function fixture(kind, { count, levels }) {
  if (kind === "list") {
    return {
      bindings: count,
      value: { elements: [{
        kind: "list", key: "bench-list", empty: "none",
        items: Array.from({ length: count }, (_, i) => ({ key: `i${i}`, label: `item ${i}`, command: "demo.open", params: { id: i } })),
      }] },
    };
  }
  let remaining = count;
  // The tree box binds two keyboard commands; each supplied branch binds one expand control.
  let bindings = 2;
  const build = (level) => {
    const index = count - remaining;
    remaining -= 1;
    const node = { key: `n${index}`, label: `node ${index}` };
    if (level + 1 < levels && remaining > 0) {
      bindings += 1;
      node.expanded = true;
      node.children = [];
      for (let i = 0; i < 2 && remaining > 0; i += 1) node.children.push(build(level + 1));
    }
    return node;
  };
  const value = { elements: [{ kind: "tree", key: "bench-tree", empty: "none", nodes: [build(0)] }] };
  if (remaining !== 0) throw new Error(`declared UI tree fixture omitted ${remaining} nodes`);
  return { value, bindings };
}

function expandedByTreeOf(elements) {
  const expandedByTree = new Map();
  for (const element of elements) {
    if (element.kind !== "tree") continue;
    const branches = new Map();
    const visit = (nodes, parent) => {
      for (const node of nodes) {
        if (!node.children?.length) continue;
        const path = [...parent, node.key];
        branches.set(JSON.stringify(path), true);
        visit(node.children, path);
      }
    };
    visit(element.nodes, []);
    expandedByTree.set(element.key, branches);
  }
  return expandedByTree;
}

function environment() {
  const processors = cpus();
  return {
    packageVersion, nodeVersion: process.version, jsdomVersion,
    platform: process.platform, arch: process.arch, osRelease: release(),
    cpu: processors[0].model, cpuCount: processors.length, loadAverage: loadavg(),
  };
}

/** Runs one complete draw, writes its measurement, and refuses incomplete work, invalid timing or a bound failure. */
export function runCase({ kind, module, document, now = () => performance.now(), write = console.log }) {
  if (!Object.hasOwn(CASES, kind)) throw new Error(`unknown declared UI benchmark case: ${kind}`);
  const specification = CASES[kind];
  const { value, bindings: expectedBindings } = fixture(kind, specification);
  const body = document.createElement("div");
  const measuredEnvironment = environment();
  let bindings = 0;
  const start = now();
  const { elements } = module.validateValue(value, OPTIONS);
  module.drawValue(body, elements, {
    statusId: "demo.bench", bind: () => { bindings += 1; }, expandedByTree: expandedByTreeOf(elements),
  });
  const end = now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    throw new Error(`declared UI ${kind} has invalid clock readings: ${start}, ${end}`);
  }
  const count = body.querySelectorAll(specification.selector).length;
  if (count !== specification.count) throw new Error(`declared UI ${kind} drew ${count} of ${specification.count}`);
  if (bindings !== expectedBindings) throw new Error(`declared UI ${kind} bound ${bindings} of ${expectedBindings}`);
  const elapsedMs = end - start;
  const { boundMs } = specification;
  const result = {
    kind, count, ...(kind === "tree" ? { levels: specification.levels } : {}), bindings,
    elapsedMs, boundMs, passed: elapsedMs <= boundMs, environment: measuredEnvironment,
  };
  write(JSON.stringify(result));
  if (!result.passed) throw new Error(`declared UI ${kind} took ${elapsedMs} ms, above the bound of ${boundMs} ms`);
  return result;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { case: { type: "string" } } });
  const { mock } = await import("node:test");
  const { JSDOM } = await import("jsdom");
  mock.module("../host.js", { namedExports: { report: (...args) => { throw new Error(`declared UI benchmark reported: ${args.join(" ")}`); } } });
  const dom = new JSDOM("<body></body>");
  globalThis.document = dom.window.document;
  try {
    runCase({ kind: values.case, module: await import("../declared-ui.js"), document });
  } finally {
    dom.window.close();
    mock.restoreAll();
  }
}
