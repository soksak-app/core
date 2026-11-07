import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as diagnostics from "../diagnostic-view-frames.js";

function fixture() {
  let rect = { x: 0, y: 0, width: 120, height: 40 };
  const text = { nodeType: 3, textContent: "ACTUAL PAINT", parentElement: null };
  const records = [];
  const observers = [];
  const document = {
    fonts: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
    createTreeWalker: () => { let delivered = false; return { nextNode() { if (delivered) return null; delivered = true; return text; } }; },
    createRange: () => {
      let start = 0, end = 0;
      return { setStart(_node, value) { start = value; }, setEnd(_node, value) { end = value; },
        getBoundingClientRect: () => ({ x: 4 + start * 8, y: 4, width: (end - start) * 8, height: 16 }),
        detach() {} };
    },
  };
  const root = { ownerDocument: document, isConnected: true, getBoundingClientRect: () => ({ ...rect }) };
  text.parentElement = root;
  class MutationObserver {
    constructor() { observers.push(this); this.disconnected = false; }
    observe() {}
    takeRecords() { return records.splice(0); }
    disconnect() { this.disconnected = true; }
  }
  class ResizeObserver extends MutationObserver {}
  const view = {
    MutationObserver, ResizeObserver,
    requestAnimationFrame: callback => { callback(10); return 1; },
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", color: "rgb(10, 20, 30)",
      backgroundColor: "rgb(255, 255, 255)", fontFamily: "sans-serif", fontSize: "16px", fontWeight: "400", fontStyle: "normal" }),
    performance: { timeOrigin: 100 }, innerWidth: 120, innerHeight: 40,
    NodeFilter: { SHOW_TEXT: 4 },
  };
  document.defaultView = view;
  return { root, view, text, observers,
    mutate() { records.push({ type: "characterData" }); },
    move() { rect.x += 1; } };
}

function create(f) {
  assert.equal(typeof diagnostics.createRenderedDocumentReferenceProvider, "function",
    "the public plugin-owned rendered document reference provider is unavailable");
  return diagnostics.createRenderedDocumentReferenceProvider({ root: f.root, provider: "fixture.actual-dom", view: f.view });
}

test("DOM renderer reference owns actual painted text and geometry without accepting consumer text", async () => {
  const f = fixture(), provider = create(f);
  const result = await provider.observe({ requestId: 7 });
  assert.equal(provider.version, 1);
  assert.equal(result.requestId, 7);
  assert.equal(result.sourceKind, "native-document");
  assert.equal(result.provider, "fixture.actual-dom");
  assert.equal(result.glyphRuns.map(run => run.text).join(""), "ACTUAL PAINT");
  assert.deepEqual(result.glyphRuns[0].glyphs[0].rect, { x: 4, y: 4, width: 8, height: 16 });
  assert.equal(await provider.validate({ requestId: 7, revision: result.revision }), true);
  await provider.release({ requestId: 7 });
  await assert.rejects(() => provider.observe({ requestId: 8, expected: { text: "invented" } }), /expected|undeclared/);
  provider.dispose();
});

test("DOM renderer reference rejects mutations and geometry changes across native snapshot lifetime", async () => {
  const f = fixture(), provider = create(f);
  let result = await provider.observe({ requestId: 7 });
  f.mutate();
  assert.equal(await provider.validate({ requestId: 7, revision: result.revision }), false);
  await provider.release({ requestId: 7 });
  result = await provider.observe({ requestId: 8 });
  f.move();
  assert.equal(await provider.validate({ requestId: 8, revision: result.revision }), false);
  await provider.release({ requestId: 8 });
  provider.dispose();
});

test("DOM renderer reference keeps one request lease until its exact owner releases it", async () => {
  const f = fixture(), provider = create(f);
  const result = await provider.observe({ requestId: 7 });
  await assert.rejects(() => provider.observe({ requestId: 8 }), /leased|pending/);
  await assert.rejects(() => provider.release({ requestId: 8 }), /owner|request/);
  assert.equal(await provider.validate({ requestId: 7, revision: result.revision }), true);
  await provider.release({ requestId: 7 });
  assert.equal((await provider.observe({ requestId: 8 })).requestId, 8);
  provider.dispose();
});

test("disposing a DOM renderer reference invalidates its lease and removes event ownership", async () => {
  const f = fixture(), provider = create(f);
  const result = await provider.observe({ requestId: 7 });
  provider.dispose();
  assert.equal(await provider.validate({ requestId: 7, revision: result.revision }), false);
  await assert.rejects(() => provider.observe({ requestId: 8 }), /closed|disposed/);
  assert.ok(f.observers.length >= 1 && f.observers.every(observer => observer.disconnected));
});


test("releasing a pending DOM reference cannot return an unowned observation after its animation callback", async () => {
  const f = fixture();
  let present, framePending;
  const pendingFrame = new Promise(resolve => { framePending = resolve; });
  f.view.requestAnimationFrame = callback => { present = callback; framePending(); return 1; };
  const provider = create(f);
  const observation = provider.observe({ requestId: 7 });
  await pendingFrame;
  assert.equal(typeof present, "function", "fixture reaches the actual pending animation callback");
  await provider.release({ requestId: 7 });
  present(10);
  await assert.rejects(observation, /owner|release|closed/);
  provider.dispose();
});


const ownerContract = JSON.parse(readFileSync(new URL("../contract/rendered-document-reference.json", import.meta.url), "utf8"));
for (const entry of ownerContract.cases) {
  test(entry.id, () => {
    const f = fixture();
    const input = { root: entry.input.root ? f.root : null, view: entry.input.view ? f.view : null, provider: entry.input.provider };
    if (entry.output.error) { assert.throws(() => diagnostics.createRenderedDocumentReferenceProvider(input), TypeError); return; }
    const provider = diagnostics.createRenderedDocumentReferenceProvider(input);
    assert.equal(provider.version, entry.output.version);
    assert.deepEqual(Object.keys(provider).filter(key => typeof provider[key] === "function").sort(), entry.output.methods);
    provider.dispose();
  });
}


test("releasing a DOM reference cancels its pending font wait without waiting for a font or animation event", { timeout: 1000 }, async t => {
  const f = fixture();
  f.root.ownerDocument.fonts.ready = new Promise(() => {});
  const provider = create(f);
  t.after(() => provider.dispose());
  const observation = provider.observe({ requestId: 7 });
  const rejected = assert.rejects(observation, /released|owner|closed/);
  await provider.release({ requestId: 7 });
  await rejected;
});

test("DOM renderer revision validation compares exact fields independently of wire key order", { timeout: 1000 }, async () => {
  const provider = create(fixture());
  try {
    const { revision } = await provider.observe({ requestId: 7 });
    assert.equal(await provider.validate({ requestId: 7,
      revision: { value: revision.value, kind: revision.kind } }), true,
    "a native bridge may reorder the same revision fields");
    for (const invalid of [
      { ...revision, extra: true }, { kind: revision.kind }, { value: revision.value },
      { kind: "other-renderer", value: revision.value }, { kind: revision.kind, value: revision.value + 1 },
      { kind: revision.kind, value: String(revision.value) }, null, [],
    ]) {
      assert.equal(await provider.validate({ requestId: 7, revision: invalid }), false,
        `an invalid revision must not validate: ${JSON.stringify(invalid)}`);
    }
    assert.equal(await provider.validate({ requestId: 7, revision }), true,
      "rejected wire revisions must not consume or change the lease");
    await provider.release({ requestId: 7 });
  } finally { provider.dispose(); }
});
