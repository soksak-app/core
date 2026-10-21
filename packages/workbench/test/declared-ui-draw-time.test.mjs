// The draw time of declared UI values at the limits of docs/spec/declared-ui.md: a tree of 5000 nodes within 16 levels
// and a list of 1000 items. Each measurement runs validateValue plus drawValue of declared-ui.js into a jsdom document
// and reports the elapsed milliseconds in its output line. The bound covers the construction and binding work only:
// jsdom builds DOM nodes without layout or paint, so the render cost of a real page is not part of the measurement.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>");
globalThis.document = dom.window.document;

mock.module("../host.js", { namedExports: { report: () => {} } });

const OPTIONS = {
  owner: "demo",
  declared: () => true,
  hasIcon: () => false,
};

const TREE_NODES = 5000;
const TREE_LEVELS = 16;
const LIST_ITEMS = 1000;
// Each bound covers the construction and binding work only: jsdom builds DOM nodes without layout or paint, so the
// render cost of a real page is not part of the measurement. The margin is about four times the recorded median
// (docs/features.md, F212.8-7: tree 501.2 ms, list 116.4 ms), so machine load does not fail the check while a
// multi-fold regression of the draw path still fails it.
const TREE_BOUND_MS = 2000;
const LIST_BOUND_MS = 500;

async function load(name) {
  return import(`../declared-ui.js?${name}`);
}

/** A tree value of exactly totalNodes nodes within maxLevels levels; every branch is expanded, so every node draws. */
function treeValue(totalNodes, maxLevels) {
  let remaining = totalNodes;
  const build = (level) => {
    const index = totalNodes - remaining;
    remaining -= 1;
    const node = { key: `n${index}`, label: `node ${index}` };
    if (level + 1 < maxLevels && remaining > 0) {
      node.expanded = true;
      node.children = [];
      for (let i = 0; i < 2 && remaining > 0; i += 1) node.children.push(...build(level + 1));
    }
    return [node];
  };
  return { elements: [{ kind: "tree", key: "bench-tree", empty: "none", nodes: build(0) }] };
}

function listValue(items) {
  return {
    elements: [{
      kind: "list", key: "bench-list", empty: "none",
      items: Array.from({ length: items }, (_, i) => ({ key: `i${i}`, label: `item ${i}`, command: "demo.open", params: { id: i } })),
    }],
  };
}

/** The kept expanded state of every branch of the value, as settle of declared-ui.js computes it for a first draw. */
function keptOf(elements) {
  const kept = new Map();
  for (const element of elements) {
    if (element.kind !== "tree") continue;
    const branches = new Map();
    const visit = (nodes, parent) => {
      for (const node of nodes) {
        if (!Array.isArray(node.children) || node.children.length === 0) continue;
        const path = [...parent, node.key];
        branches.set(JSON.stringify(path), true);
        visit(node.children, path);
      }
    };
    visit(element.nodes, []);
    kept.set(element.key, branches);
  }
  return kept;
}

function measure(module, value) {
  const body = document.createElement("div");
  const started = performance.now();
  const { elements } = module.validateValue(value, OPTIONS);
  module.drawValue(body, elements, { statusId: "demo.bench", bind: () => {}, kept: keptOf(elements) });
  return { elapsed: performance.now() - started, body };
}

test("a tree of 5000 nodes within 16 levels validates and draws within the bound", { timeout: 30000 }, async () => {
  const module = await load("bench-tree");
  const { elapsed, body } = measure(module, treeValue(TREE_NODES, TREE_LEVELS));
  console.log(`declared UI draw time: tree of ${TREE_NODES} nodes within ${TREE_LEVELS} levels: ${elapsed.toFixed(1)} ms (bound ${TREE_BOUND_MS} ms)`);
  assert.equal(body.querySelectorAll(".declared-node").length, TREE_NODES, "the tree did not draw every node");
  assert.ok(elapsed < TREE_BOUND_MS, `the draw of ${TREE_NODES} tree nodes took ${elapsed.toFixed(1)} ms, above the bound of ${TREE_BOUND_MS} ms`);
});

test("a list of 1000 items validates and draws within the bound", { timeout: 10000 }, async () => {
  const module = await load("bench-list");
  const { elapsed, body } = measure(module, listValue(LIST_ITEMS));
  console.log(`declared UI draw time: list of ${LIST_ITEMS} items: ${elapsed.toFixed(1)} ms (bound ${LIST_BOUND_MS} ms)`);
  assert.equal(body.querySelectorAll(".declared-row").length, LIST_ITEMS, "the list did not draw every item");
  assert.ok(elapsed < LIST_BOUND_MS, `the draw of ${LIST_ITEMS} list items took ${elapsed.toFixed(1)} ms, above the bound of ${LIST_BOUND_MS} ms`);
});
