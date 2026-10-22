// Measures what an unload of hidden DOM tabs returns to the main page: the JS heap and the DOM node count with N hidden tabs
// of each fixture kind mounted, and after each tab is released through disposeSurface({mode: "unload"}) (docs/spec/plugins.md#memory-saver).
//
// The fixtures are surfaces of this test tree with the size of a working tab: a text buffer, its
// decorated visible lines and a copy of the document synchronized to another process; a rendered markdown document with
// its source; a scrollback and its visible grid. The page runs in jsdom under Node, so the heap is the
// V8 heap after a full collection, which holds the JS objects of the surfaces and the DOM objects of jsdom; WebKit gives a
// page no reading of its JS heap. Run as a program, it prints one JSON line per kind and fails only when a kind was not
// measured; measureKind is exported for its test. `make hidden-tab-memory` runs it.
//
//   node --expose-gc --experimental-test-module-mocks packages/workbench/benchmark/hidden-tab-memory.mjs [--tabs N]
import { mock } from "node:test";
import { parseArgs } from "node:util";
import { JSDOM } from "jsdom";

const { registerPlugin } = await import("../registry.js");
const { openTabStates } = await import("../tab-state.js");
const { recordOrigin } = await import("../tab-reports.js");
const UNLOAD = { format: 1, maxBytes: 65536 };
const store = await openTabStates({
  store: { tabState: async () => null, tabStatePut: async () => 0 },
  failed: (error) => { throw error; },
  unloadOf: () => UNLOAD,
});
mock.module("../projects.js", { namedExports: { active: () => null, tabStateStore: () => store, tabStatesReady: async () => store } });
mock.module("../environment.js", { namedExports: { pluginDiagnostics: async () => null } });
globalThis.dispatchEvent = (event) => { throw new Error(`the benchmark page reported an error: ${event.message}`); };
export const KINDS = ["text-buffer", "rendered-document", "scrollback"];
for (const kind of KINDS) registerPlugin({ id: `fixture-${kind}`, surface: () => null });
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);
const dom = new JSDOM("<main></main>", { url: "http://localhost/" });
globalThis.document = dom.window.document;
const { mountSurface, disposeSurface } = await import("../surface-modules.js");
const main = document.querySelector("main");
// A hidden tab of a card is held in a fragment outside the document, which a count of the document does not reach, so each tab
// has its own slot; the objects of a tab are the same in either place.
const slotOf = (id) => {
  const slot = document.createElement("div");
  slot.dataset.slot = id;
  main.append(slot);
  return slot;
};

// Each fixture builds its objects in mount, keeps them only in the closure of the module instance and empties its root at dispose.
export const FIXTURES = {
  // 20000 lines of about 64 characters, 80 visible lines of up to 8 tokens with a gutter, and the JSON copy that a language server process holds in sync.
  "text-buffer": `export function mount(root, context) {
    const lines = Array.from({ length: 20000 }, (_, i) => ("const value" + i + " = compute(" + i + ", options);").padEnd(56, " ") + "x".repeat(8 + (i % 7)));
    let synchronized = JSON.stringify({ uri: "file:///fixture.js", version: 1, text: lines.join("\\n") });
    const view = document.createElement("div");
    for (let i = 0; i < 80; i++) {
      const row = document.createElement("div");
      const gutter = document.createElement("span");
      gutter.textContent = String(i + 1);
      row.append(gutter);
      for (const token of lines[i].split(/(?=[ (,;])/).slice(0, 8)) {
        const span = document.createElement("span");
        span.className = "token";
        span.textContent = token;
        row.append(span);
      }
      view.append(row);
    }
    root.append(view);
    context.tab.state.write({ cursor: [0, 0], scroll: 0 });
    return { dispose() { root.replaceChildren(); lines.length = 0; synchronized = null; } };
  }`,
  // 3000 blocks of headings, paragraphs with inline marks and list items, all rendered, and the source text.
  "rendered-document": `export function mount(root, context) {
    let source = Array.from({ length: 3000 }, (_, i) => i % 10 === 0 ? "## Section " + i : i % 3 === 0 ? "- item " + i + " with **bold** text" : "Paragraph " + i + " has *emphasis*, and a [link](https://example.com/" + i + ").").join("\\n\\n");
    const article = document.createElement("article");
    for (const block of source.split("\\n\\n")) {
      const element = document.createElement(block.startsWith("##") ? "h2" : block.startsWith("-") ? "li" : "p");
      for (const part of block.split(/(\\*\\*[^*]+\\*\\*|\\*[^*]+\\*|\\[[^\\]]+\\]\\([^)]+\\))/)) {
        if (!part) continue;
        const mark = part.startsWith("**") ? "strong" : part.startsWith("*") ? "em" : part.startsWith("[") ? "a" : null;
        const node = mark ? document.createElement(mark) : document.createTextNode(part);
        if (mark) node.textContent = part.replace(/[*\\[\\]]|\\(.*\\)$/g, "");
        element.append(node);
      }
      article.append(element);
    }
    root.append(article);
    context.tab.state.write({ scroll: 0 });
    return { dispose() { root.replaceChildren(); source = null; } };
  }`,
  // 10000 scrollback rows of 120 cells and 50 visible rows of 12 colored runs.
  scrollback: `export function mount(root, context) {
    const scrollback = Array.from({ length: 10000 }, (_, i) => ("$ build step " + i + " ").padEnd(120, String.fromCharCode(97 + (i % 26))));
    const grid = document.createElement("div");
    for (let r = 0; r < 50; r++) {
      const row = document.createElement("div");
      for (let c = 0; c < 12; c++) {
        const run = document.createElement("span");
        run.style.color = "#" + ((r * 12 + c) * 99991 % 16777216).toString(16).padStart(6, "0");
        run.textContent = scrollback[scrollback.length - 50 + r].slice(c * 10, c * 10 + 10);
        row.append(run);
      }
      grid.append(row);
    }
    root.append(grid);
    context.tab.state.write({ cwd: "/" });
    return { dispose() { root.replaceChildren(); scrollback.length = 0; } };
  }`,
};

// The tab creation of the workbench records the origin of each tab (docs/spec/projects.md#tab-origin); a mount reads it, so the benchmark records it.
const surface = (kind, surfaceId, source) => {
  recordOrigin(surfaceId, null);
  return {
    module: `data:text/javascript,${encodeURIComponent(source)}`,
    surfaceId, pluginId: `fixture-${kind}`, unload: UNLOAD, composition: { kind: "dom" }, declarations: {}, sidecars: [],
  };
};
// The nodes of the document and of every shadow root in it, because a surface draws in the shadow root of its host.
const countNodes = (root) => {
  let count = 0;
  const walker = document.createTreeWalker(root, dom.window.NodeFilter.SHOW_ALL);
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    count += 1;
    if (node.shadowRoot) count += countNodes(node.shadowRoot);
  }
  return count;
};

/**
 * Mounts tabs hidden surfaces of the kind from source, releases them in the unload mode and returns the entry of the kind.
 * collect() runs a full collection after the pending tasks of the releases have run; the program passes the collection of
 * node --expose-gc.
 */
export async function measureKind({ kind, tabs, source = FIXTURES[kind], collect }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown fixture kind: ${kind}`);
  if (!Number.isInteger(tabs) || tabs < 1) throw new Error(`tabs must be a positive integer, got ${tabs}`);
  const measure = async () => {
    for (let i = 0; i < 3; i++) { await new Promise((resolve) => setImmediate(resolve)); collect(); }
    return { heapBytes: process.memoryUsage().heapUsed, domNodes: countNodes(document) };
  };
  const ids = Array.from({ length: tabs }, (_, i) => `${kind}-${i}`);
  // The first mount and release of a kind loads its module once, so the module code is not counted as the cost of a tab.
  await mountSurface(slotOf(`${kind}-warm`), surface(kind, `${kind}-warm`, source));
  await disposeSurface(`${kind}-warm`);
  main.querySelector(`[data-slot="${kind}-warm"]`).remove();
  const before = await measure();
  for (const id of ids) await mountSurface(slotOf(id), surface(kind, id, source));
  const mounted = await measure();
  for (const id of ids) await disposeSurface(id, { mode: "unload" });
  for (const slot of main.querySelectorAll("[data-slot]")) slot.remove();
  const unloaded = await measure();
  const perTab = (from, to) => ({ heapBytes: Math.round((to.heapBytes - from.heapBytes) / tabs), domNodes: (to.domNodes - from.domNodes) / tabs });
  return {
    kind, tabs, before, mounted, unloaded,
    mountedPerTab: perTab(before, mounted), returnedPerTab: perTab(unloaded, mounted),
    storedStateBytes: JSON.stringify(store.entry(ids[0]).state).length,
  };
}

if (import.meta.main) {
  if (typeof globalThis.gc !== "function") throw new Error("hidden-tab-memory requires node --expose-gc");
  const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { tabs: { type: "string", default: "4" } } });
  const tabs = Number(values.tabs);
  if (!Number.isInteger(tabs) || tabs < 1) throw new Error(`--tabs must be a positive integer, got ${values.tabs}`);
  let measured = 0;
  for (const kind of KINDS) {
    console.log(JSON.stringify(await measureKind({ kind, tabs, collect: globalThis.gc })));
    measured += 1;
  }
  if (measured !== KINDS.length) throw new Error(`measured ${measured} of ${KINDS.length} kinds`);
  dom.window.close();
}
