import assert from "node:assert/strict";
import test, { mock } from "node:test";

// The host calls of the document regions, answered by the fakes of each test.
const calls = [];
const reports = [];
const answers = { documentQuery: null, documentInteractionState: null };
const actualHost = await import("../host.js");
mock.module("../host.js", {
  exports: {
    ...actualHost,
    documents: {
      query: (surface, document) => { calls.push(["documentQuery", surface, document]); return answers.documentQuery(surface, document); },
      interactionState: (surface, document) => {
        calls.push(["documentInteractionState", surface, document]);
        return answers.documentInteractionState(surface, document);
      },
    },
    report: (line) => reports.push(line),
  },
});
const { createDocumentRegions } = await import("../document-regions.js");

test.beforeEach(() => {
  calls.length = 0;
  reports.length = 0;
});

test("the reasons of a tab are the query replies of its attached regions", async () => {
  const regions = createDocumentRegions();
  answers.documentQuery = async (_surface, document) => ({
    page: { media: true, capture: false, form: false },
    side: { media: false, capture: true, form: true },
    idle: { media: false, capture: false, form: false },
  })[document];
  regions.attached("tab", "page");
  regions.attached("tab", "side");
  regions.attached("other", "idle");
  assert.deepEqual(await regions.reasons("tab"), ["media", "capture", "form"]);
  assert.deepEqual(calls, [["documentQuery", "tab", "page"], ["documentQuery", "tab", "side"]]);
  assert.deepEqual(await regions.reasons("other"), []);
  regions.detached("tab", "page");
  calls.length = 0;
  assert.deepEqual(await regions.reasons("tab"), ["capture", "form"]);
  assert.deepEqual(calls, [["documentQuery", "tab", "side"]]);
  regions.released("tab");
  assert.deepEqual(await regions.reasons("tab"), []);
});

test("a failed query gives media-unknown and is logged", async () => {
  const regions = createDocumentRegions();
  answers.documentQuery = async () => { throw new Error("document page: the document region is closed"); };
  regions.attached("tab", "page");
  assert.deepEqual(await regions.reasons("tab"), ["media-unknown"]);
  assert.deepEqual(reports, ["memory saver: tab tab: document page: the document region is closed"]);
});

test("the interactionState of each region returns to the region of the same name on restore", async () => {
  const regions = createDocumentRegions();
  answers.documentInteractionState = async (_surface, document) => ({ page: "AAAA", empty: "" })[document];
  regions.attached("tab", "page");
  regions.attached("tab", "empty");
  const history = await regions.interaction("tab");
  assert.deepEqual(history, { page: "AAAA" });
  regions.released("tab");
  regions.restore("tab", history);
  assert.deepEqual(regions.attachRequest("tab", "page"), { document: "page", interactionState: "AAAA" });
  // The state is restored once: a later region of the same name loads without it.
  assert.deepEqual(regions.attachRequest("tab", "page"), { document: "page" });
  assert.deepEqual(regions.attachRequest("tab", "empty"), { document: "empty" });
});

test("a tab whose regions yield no interactionState has no history", async () => {
  const regions = createDocumentRegions();
  answers.documentInteractionState = async () => "";
  assert.equal(await regions.interaction("none"), undefined);
  regions.attached("tab", "page");
  assert.equal(await regions.interaction("tab"), undefined);
  regions.restore("tab", undefined);
  assert.deepEqual(regions.attachRequest("tab", "page"), { document: "page" });
});
