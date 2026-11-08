import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function requireHostDocuments(host) {
  assert.ok(host && Array.isArray(host.documents), "host.window must expose its document inventory");
  for (const [index, row] of host.documents.entries()) {
    assert.ok(typeof row?.surface === "string" && row.surface.length > 0,
      `host.window document row ${index} has an invalid surface identity`);
    assert.ok(typeof row.document === "string", `host.window document row ${index} has an invalid document identity`);
    assert.ok(Number.isSafeInteger(row.process) && row.process >= 0,
      `host.window document row ${index} has invalid process PID ${JSON.stringify(row.process)}`);
  }
  return host.documents;
}

function requireSurfaces(surfaces) {
  assert.ok(Array.isArray(surfaces) && surfaces.length > 0, "view surfaces must be a nonempty array");
  assert.ok(surfaces.every((surface) => typeof surface === "string" && surface.length > 0),
    "view surfaces must contain nonempty text");
  assert.equal(new Set(surfaces).size, surfaces.length, "view surfaces must be unique");
}

function requireDocumentRows(documents, surfaces) {
  const selected = new Set(surfaces);
  const rows = documents.filter((row) => selected.has(row.surface));
  for (const surface of surfaces) {
    const attached = rows.filter((row) => row.surface === surface);
    assert.ok(attached.some((row) => row.document === ""), `${surface} has no view root process in host.window`);
    assert.equal(attached.filter((row) => row.document === "").length, 1,
      `${surface} has multiple view root processes in host.window`);
    assert.equal(new Set(attached.map((row) => row.document)).size, attached.length,
      `${surface} repeats a document identity in host.window`);
  }
  return rows;
}

/** Returns the process that owns each requested view root; child document processes are excluded. */
export function viewRootProcessPids(host, surfaces) {
  const documents = requireHostDocuments(host);
  requireSurfaces(surfaces);
  const rows = requireDocumentRows(documents, surfaces).filter((row) => row.document === "");
  for (const row of rows) assert.ok(row.process > 0,
    `host.window view root ${row.surface} has invalid process PID ${JSON.stringify(row.process)}`);
  return [...new Set(rows.map((row) => row.process))].sort((left, right) => left - right);
}

/** Returns all currently exposed view-root process identities for startup classification. */
export function allViewRootProcessPids(host) {
  const documents = requireHostDocuments(host);
  return [...new Set(documents.filter((row) => row.document === "" && row.process > 0).map((row) => row.process))]
    .sort((left, right) => left - right);
}

/** Expands process sharing transitively across every root and native child document. */
export function viewProcessGroup(host, surfaces) {
  const documents = requireHostDocuments(host);
  requireSurfaces(surfaces);
  const selectedSurfaces = new Set(surfaces);
  const selectedPids = new Set(viewRootProcessPids(host, surfaces));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of documents) {
      if (row.process > 0 && selectedPids.has(row.process) && !selectedSurfaces.has(row.surface)) {
        viewRootProcessPids(host, [row.surface]);
        selectedSurfaces.add(row.surface);
        changed = true;
      }
      if (selectedSurfaces.has(row.surface) && row.process > 0 && !selectedPids.has(row.process)) {
        selectedPids.add(row.process);
        changed = true;
      }
    }
  }
  const groupSurfaces = [...selectedSurfaces].sort();
  const groupDocuments = requireDocumentRows(documents, groupSurfaces)
    .filter(({ process }) => process > 0)
    .map(({ surface, document, process }) => ({ surface, document, process }))
    .sort((left, right) => left.surface.localeCompare(right.surface) || left.document.localeCompare(right.document));
  const pids = [...selectedPids].sort((left, right) => left - right);
  assert.deepEqual([...new Set(groupDocuments.map((row) => row.process))].sort((a, b) => a - b), pids,
    "view process group omitted an attached root or native document process");
  return { surfaces: groupSurfaces, pids, documents: groupDocuments };
}

/** Returns every unique process used by the requested view surfaces and their shared-process neighbors. */
export function viewProcessPids(host, surfaces) {
  return viewProcessGroup(host, surfaces).pids;
}

/** Returns every view surface attached to the selected process group, including transitive process sharing. */
export function viewProcessSurfaces(host, pids) {
  const documents = requireHostDocuments(host);
  assert.ok(Array.isArray(pids) && pids.length > 0, "view process identities must be nonempty");
  assert.equal(new Set(pids).size, pids.length, "view process identities must be unique");
  for (const pid of pids) assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid view process PID ${JSON.stringify(pid)}`);
  const seed = new Set(pids);
  const surfaces = documents.filter((row) => seed.has(row.process)).map((row) => row.surface);
  assert.ok(surfaces.length > 0, `host.window exposes no view surface for process group ${pids.join(",")}`);
  const group = viewProcessGroup(host, [...new Set(surfaces)]);
  assert.deepEqual(group.pids, [...seed].sort((a, b) => a - b),
    "selected process identities do not represent the complete shared view group");
  return group.surfaces;
}

/** Returns every exact root and native document row attached to the selected complete process group. */
export function viewProcessDocuments(host, pids) {
  const surfaces = viewProcessSurfaces(host, pids);
  return viewProcessGroup(host, surfaces).documents;
}

/** Splits live child documents from reserved, not-yet-started child rows for one view. */
export function viewDocumentHistoryInventory(host, surface, regionHistoryEntries) {
  requireSurfaces([surface]);
  assert.ok(Number.isSafeInteger(regionHistoryEntries) && regionHistoryEntries >= 0,
    `view ${surface} has invalid region history count ${JSON.stringify(regionHistoryEntries)}`);
  const rows = requireHostDocuments(host).filter((row) => row.surface === surface && row.document !== "");
  const documents = viewProcessGroup(host, [surface]).documents
    .filter((row) => row.surface === surface && row.document !== "");
  const unstartedDocuments = rows.filter((row) => row.process === 0)
    .map(({ document, process }) => ({ document, process, historyEntries: regionHistoryEntries }));
  assert.ok(unstartedDocuments.length === 0 || regionHistoryEntries === 0,
    `view ${surface} has an unstarted child document and nonzero region history ${regionHistoryEntries}`);
  assert.equal(documents.length, regionHistoryEntries,
    `view ${surface} has ${documents.length} started documents but reports ${regionHistoryEntries} region history entries`);
  return { documents, unstartedDocuments };
}

/** Measures each exact process identity with the operating system's physical-footprint tool. */
export async function measureProcessGroup(pids, measureFootprint = physicalFootprintBytes) {
  assert.ok(Array.isArray(pids) && pids.length > 0, "view process group must be nonempty");
  assert.equal(new Set(pids).size, pids.length, "view process group PIDs must be unique");
  const rows = [];
  for (const pid of pids) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid view process PID ${JSON.stringify(pid)}`);
    const footprintBytes = await measureFootprint(pid);
    assert.ok(Number.isSafeInteger(footprintBytes) && footprintBytes > 0,
      `view process ${pid} footprint must be a positive safe integer, found ${JSON.stringify(footprintBytes)}`);
    rows.push({ pid, footprintBytes });
  }
  return rows;
}

/** Returns the physical footprint in bytes reported by macOS for one process. */
export function physicalFootprintBytes(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid view process PID ${JSON.stringify(pid)}`);
  const output = execFileSync("footprint", ["-p", String(pid), "-f", "bytes"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
  return parsePhysicalFootprint(output, pid);
}

/** Parses the single macOS WebKit byte-footprint header for the requested PID. */
export function parsePhysicalFootprint(output, pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid view process PID ${JSON.stringify(pid)}`);
  assert.ok(typeof output === "string", `physical footprint output for ${pid} must be text`);
  const rows = output.split(/\r?\n/u).filter((line) => line.includes("Footprint:"));
  assert.equal(rows.length, 1,
    `physical footprint of ${pid} must contain exactly one Footprint row, found ${rows.length}: ${output.trim()}`);
  const match = /^\s*com\.apple\.WebKit\.WebContent \[(\d+)\]: 64-bit\s+Footprint: (\d+) B \((\d+) bytes per page\)\s*$/u.exec(rows[0]);
  assert.ok(match, `physical footprint of ${pid} has an invalid macOS WebKit Footprint row: ${rows[0]}`);
  assert.equal(Number(match[1]), pid, `physical footprint PID ${match[1]} does not match requested PID ${pid}`);
  const bytes = Number(match[2]);
  const pageBytes = Number(match[3]);
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0,
    `view process ${pid} returned invalid footprint ${match[2]}`);
  assert.ok(Number.isSafeInteger(pageBytes) && pageBytes > 0,
    `view process ${pid} returned invalid page size ${match[3]}`);
  return bytes;
}

/** Builds reclaim evidence while retaining every process identity from before closure. */
export function processGroupReclaimEvidence({ beforeProcesses, afterProcesses, elapsedMs, closedViews, engineCacheHeld }) {
  assert.ok(Array.isArray(beforeProcesses) && beforeProcesses.length > 0,
    "view reclaim requires a nonempty pre-close process group");
  assert.ok(Array.isArray(afterProcesses), "view reclaim requires post-close process samples");
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0, "view reclaim elapsed time must be finite and nonnegative");
  assert.equal(typeof engineCacheHeld, "boolean", "view reclaim requires process-liveness evidence");
  assert.ok(Array.isArray(closedViews) && closedViews.length > 0,
    "view reclaim requires closed-view history evidence");
  const before = new Map();
  for (const row of beforeProcesses) {
    assert.ok(Number.isSafeInteger(row?.pid) && row.pid > 0, "view reclaim has an invalid pre-close PID");
    assert.ok(Number.isSafeInteger(row.footprintBytes) && row.footprintBytes > 0,
      `view reclaim pre-close footprint for ${row.pid} must be a positive safe integer`);
    assert.ok(!before.has(row.pid), `view reclaim repeats pre-close PID ${row.pid}`);
    before.set(row.pid, row);
  }
  const after = new Map();
  for (const row of afterProcesses) {
    assert.ok(Number.isSafeInteger(row?.pid) && row.pid > 0, "view reclaim has an invalid post-close PID");
    assert.ok(Number.isSafeInteger(row.footprintBytes) && row.footprintBytes >= 0,
      `view reclaim post-close footprint for ${row.pid} must be a nonnegative safe integer`);
    assert.ok(before.has(row.pid), `view reclaim introduced unmeasured PID ${row.pid}`);
    assert.ok(!after.has(row.pid), `view reclaim repeats post-close PID ${row.pid}`);
    after.set(row.pid, row);
  }
  assert.deepEqual([...after.keys()].sort((a, b) => a - b), [...before.keys()].sort((a, b) => a - b),
    "view reclaim must retain the same PID identities, with ended processes represented as zero");
  for (const view of closedViews) {
    assert.ok(typeof view?.surface === "string" && view.surface.length > 0, "closed view has no surface identity");
    assert.equal(view.rootHistoryEntries, 1,
      `${view.surface} root session history must contain only its initial document`);
    assert.ok(Array.isArray(view.documents), `${view.surface} attached document history rows must be an array`);
    const names = new Set();
    for (const document of view.documents) {
      assert.ok(typeof document?.document === "string" && document.document.length > 0,
        `${view.surface} has an invalid attached document identity`);
      assert.ok(!names.has(document.document), `${view.surface} repeats attached document ${document.document}`);
      names.add(document.document);
      assert.equal(document.historyEntries, 1,
        `${view.surface} document ${document.document} history must contain only its initial document`);
    }
  }
  assert.equal(engineCacheHeld, afterProcesses.some((row) => row.footprintBytes > 0),
    "view reclaim cache-held flag must match process liveness after all views close");
  return { beforeProcesses, afterProcesses, elapsedMs, engineCacheHeld, closedViews };
}
