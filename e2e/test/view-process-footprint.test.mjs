import assert from "node:assert/strict";
import test from "node:test";

import { allViewRootProcessPids, measureProcessGroup, parsePhysicalFootprint, processGroupReclaimEvidence,
  viewDocumentHistoryInventory, viewProcessDocuments, viewProcessGroup, viewProcessPids, viewProcessSurfaces,
  viewRootProcessPids }
  from "../view-process-footprint.mjs";

test("view process inventory uses only requested empty-document view rows", () => {
  const host = { documents: [
    { surface: "view-a", document: "", process: 401 },
    { surface: "view-b", document: "", process: 402 },
    { surface: "view-a", document: "page", process: 999 },
    { surface: "other", document: "", process: 403 },
    { surface: "not-started", document: "", process: 0 },
    { surface: "not-started", document: "page", process: 0 },
  ] };
  assert.deepEqual(viewProcessPids(host, ["view-a", "view-b"]), [401, 402, 999]);
  assert.deepEqual(allViewRootProcessPids(host), [401, 402, 403]);
  assert.deepEqual(viewProcessPids({ documents: [
    { surface: "view-a", document: "", process: 401 },
    { surface: "view-b", document: "", process: 401 },
  ] }, ["view-a", "view-b"]), [401]);
});

test("view process inventory rejects absent, duplicate, and invalid view rows", () => {
  assert.throws(() => viewProcessPids({ documents: [] }, ["view-a"]), /no view root process/);
  assert.throws(() => viewProcessPids({ documents: [
    { surface: "view-a", document: "", process: 401 },
    { surface: "view-a", document: "", process: 402 },
  ] }, ["view-a"]), /multiple view root processes/);
  assert.throws(() => viewProcessPids({ documents: [
    { surface: "view-a", document: "", process: 0 },
  ] }, ["view-a"]), /invalid process PID/);
  assert.deepEqual(viewProcessPids({ documents: [
    { surface: "view-a", document: "", process: 401 },
    { surface: "view-a", document: "page", process: 0 },
  ] }, ["view-a"]), [401]);
});

test("all view PID snapshots are unique, exact, and reject invalid rows", () => {
  assert.deepEqual(allViewRootProcessPids({ documents: [
    { surface: "view-a", document: "", process: 402 }, { surface: "view-a", document: "page", process: 999 },
    { surface: "view-b", document: "", process: 401 },
  ] }), [401, 402]);
  assert.throws(() => allViewRootProcessPids({ documents: [
    { surface: "view-a", document: "", process: -1 },
  ] }), /invalid process PID/);
});

test("process group surface inventory includes every attached view and rejects omissions", () => {
  const host = { documents: [
    { surface: "view-a", document: "", process: 401 },
    { surface: "view-b", document: "", process: 401 },
    { surface: "view-c", document: "", process: 402 },
    { surface: "view-a", document: "page", process: 900 },
  ] };
  assert.deepEqual(viewProcessSurfaces(host, [401, 402, 900]), ["view-a", "view-b", "view-c"]);
  assert.deepEqual(viewProcessSurfaces(host, [402]), ["view-c"]);
  assert.throws(() => viewProcessSurfaces(host, [403]), /no view surface/);
  assert.throws(() => viewProcessSurfaces(host, [401, 401]), /must be unique/);
});

test("view footprint includes root and every native document process for each selected surface", () => {
  const host = { documents: [
    { surface: "view-a", document: "", process: 401 },
    { surface: "view-a", document: "page", process: 501 },
    { surface: "view-a", document: "image", process: 501 },
    { surface: "view-b", document: "", process: 402 },
  ] };
  assert.deepEqual(viewRootProcessPids(host, ["view-a"]), [401]);
  assert.deepEqual(viewProcessPids(host, ["view-a"]), [401, 501]);
});

test("an unstarted child document has no PID footprint or document-history row", async () => {
  const host = { documents: [
    { surface: "browser-empty", document: "", process: 401 },
    { surface: "browser-empty", document: "page", process: 0 },
    { surface: "unrelated-not-started", document: "page", process: 0 },
    { surface: "other", document: "", process: 402 },
  ] };
  const group = viewProcessGroup(host, ["browser-empty"]);
  assert.deepEqual(group.surfaces, ["browser-empty"]);
  assert.deepEqual(group.pids, [401]);
  assert.deepEqual(group.documents, [
    { surface: "browser-empty", document: "", process: 401 },
  ]);
  assert.deepEqual(viewProcessDocuments(host, [401]), group.documents);
  assert.deepEqual(viewDocumentHistoryInventory(host, "browser-empty", 0), {
    documents: [], unstartedDocuments: [{ document: "page", process: 0, historyEntries: 0 }],
  });
  assert.throws(() => viewProcessGroup(host, ["unrelated-not-started"]), /no view root process/);
  const sampled = [];
  const measured = await measureProcessGroup(viewProcessPids(host, ["browser-empty"]), async (pid) => {
    sampled.push(pid);
    return 4_000_000;
  });
  assert.deepEqual(sampled, [401]);
  assert.deepEqual(measured, [{ pid: 401, footprintBytes: 4_000_000 }]);
});

test("footprint and close inventories expand process sharing transitively through native child documents", () => {
  const host = { documents: [
    { surface: "view-a", document: "", process: 401 },
    { surface: "view-a", document: "page", process: 501 },
    { surface: "view-b", document: "", process: 402 },
    { surface: "view-b", document: "page", process: 501 },
    { surface: "view-c", document: "", process: 402 },
  ] };
  assert.deepEqual(viewProcessPids(host, ["view-a"]), [401, 402, 501]);
  assert.deepEqual(viewProcessSurfaces(host, [401, 402, 501]), ["view-a", "view-b", "view-c"]);
  assert.deepEqual(viewProcessDocuments(host, [401, 402, 501]), [
    { surface: "view-a", document: "", process: 401 },
    { surface: "view-a", document: "page", process: 501 },
    { surface: "view-b", document: "", process: 402 },
    { surface: "view-b", document: "page", process: 501 },
    { surface: "view-c", document: "", process: 402 },
  ]);
});

test("process group measurement retains exact PIDs and physical bytes", async () => {
  const sampled = [];
  assert.deepEqual(await measureProcessGroup([401, 402], async (pid) => {
    sampled.push(pid);
    return pid * 1000;
  }), [{ pid: 401, footprintBytes: 401000 }, { pid: 402, footprintBytes: 402000 }]);
  assert.deepEqual(sampled, [401, 402]);
  await assert.rejects(measureProcessGroup([401], async () => 0), /positive safe integer/);
});

test("physical footprint parser requires one safe positive byte row", () => {
  assert.equal(parsePhysicalFootprint("PID: 401\nFootprint: 123456 B\n"), 123456);
  assert.throws(() => parsePhysicalFootprint("no footprint row"), /exactly one Footprint row, found 0/);
  assert.throws(() => parsePhysicalFootprint("Footprint: 1 B\nFootprint: 2 B"), /exactly one Footprint row, found 2/);
  assert.throws(() => parsePhysicalFootprint("Footprint: 0 B"), /invalid footprint/);
  assert.throws(() => parsePhysicalFootprint("Footprint: 9007199254740992 B"), /invalid footprint/);
});

test("reclaim evidence keeps ended PIDs as zero and proves one-entry histories", () => {
  const beforeProcesses = [{ pid: 401, footprintBytes: 5_000_000 }, { pid: 402, footprintBytes: 4_000_000 }];
  const afterProcesses = [{ pid: 401, footprintBytes: 0 }, { pid: 402, footprintBytes: 0 }];
  const closedViews = [{ surface: "view-a", rootHistoryEntries: 1, documents: [{ document: "page", historyEntries: 1 }] },
    { surface: "view-b", rootHistoryEntries: 1, documents: [] }];
  assert.deepEqual(processGroupReclaimEvidence({ beforeProcesses, afterProcesses, elapsedMs: 50,
    closedViews, engineCacheHeld: false }), { beforeProcesses, afterProcesses, elapsedMs: 50, engineCacheHeld: false, closedViews });
  assert.throws(() => processGroupReclaimEvidence({ beforeProcesses, afterProcesses: afterProcesses.slice(1),
    elapsedMs: 50, closedViews, engineCacheHeld: false }), /same PID identities/);
  assert.throws(() => processGroupReclaimEvidence({ beforeProcesses, afterProcesses,
    elapsedMs: 50, closedViews: [{ surface: "view-a", rootHistoryEntries: 2, documents: [] }], engineCacheHeld: false }),
  /only its initial document/);
  assert.throws(() => processGroupReclaimEvidence({ beforeProcesses, afterProcesses: afterProcesses.map((row) =>
    ({ ...row, footprintBytes: 1 })), elapsedMs: 50, closedViews, engineCacheHeld: false }), /cache-held flag/);
});
