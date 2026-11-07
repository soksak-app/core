// Collects real public Browser-page reference wire and retained SCK evidence.
// A successful collection is not an earliest-frame or selected-glyph proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { frames } from "@soksak/window-check/frame.mjs";
import { readPng } from "@soksak/window-check/png.mjs";
import { serveContentPage } from "./benchmark/cases/browser.mjs";
import { captureDocumentReference, documentIdentityCardIds, verifyDocumentFrameIdentityCapture } from "./document-frame-identity.mjs";
import { fresh } from "./fixture.mjs";

const EXPECTED = "SOKSAK BROWSER CONTENT";
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const readRows = path => readFileSync(path, "utf8").trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line));
const tuple = value => value && [value.generation, value.raster, value.sequence].map(String).join("/");

for (const app of Object.values(APPS)) {
  test(`${app.name}: public Browser page reference retains native PNG and its actual document-identity recording`, { timeout: 120000 }, async t => {
    const s = await open(t, app, { inactive: true });
    assert.ok(s, "the declared application reference collector must run");
    await fresh(s, { performanceTrace: false });
    const grid = await s.get("core.grid");
    const [card] = documentIdentityCardIds(grid);
    const { tab: surface } = await s.run("core.card.add-tab", { card, plugin: "browser" });
    assert.ok(typeof surface === "string" && surface, "the public Browser card command returned no surface");
    s.cleanup(async () => {
      const surfaces = await s.get("core.surfaces");
      if (surfaces.some(item => item.surface === surface)) await s.run("core.tab.close", { tab: surface });
    });
    await s.run("core.tab.select", { tab: surface });
    await s.until("core.surfaces", rows => rows.some(row => row.surface === surface && row.visible
      && row.exposes.includes("status browser.location")), "the Browser view did not expose its public location state");
    const url = await serveContentPage(s);
    await s.run("browser.navigate", { url }, surface);
    await s.until("browser.location", value => value.url === url && value.title === EXPECTED
      && value.loading === false && value.error === null,
    "the controlled Browser document did not finish loading", { surface });
    // Reference rendering has its own declared covered-window preparation;
    // it neither activates the application nor changes a measured interval.
    s.cleanup(() => s.request("diagnostics.window.draw-covered", { draw: false }));
    await s.request("diagnostics.window.draw-covered", { draw: true });
    await s.presented();

    // Preserve the actual public target geometry even if the one-shot API
    // fails before returning its native artifact metadata. This is diagnostic
    // context, never a replacement for source/capture geometry validation.
    const runFolder = process.env.SOKSAK_RUN_FOLDER;
    assert.ok(typeof runFolder === "string" && runFolder, "the maintained collector requires its declared run folder");
    const beforeHost = await s.get("host.window");
    const preflight = join(runFolder, `${app.name}-document-reference-preflight-${process.pid}`);
    mkdirSync(preflight, { recursive: false });
    writeFileSync(join(preflight, "host-before.json"), JSON.stringify({ host: beforeHost,
      request: { surface, document: "page", requestId: 1 } }, null, 2) + "\n");
    t.diagnostic(`${app.name}: original public document reference preflight retained at ${preflight}`);

    const packet = await captureDocumentReference(s, { surface, document: "page", requestId: 1 });
    // Preserve the original public replies and exact bytes before any validation.
    // Replay path relocation belongs to a separate declared fixture loader.
    const preserved = join(runFolder, `${app.name}-document-reference-${basename(packet.capture.frames)}`);
    mkdirSync(preserved, { recursive: false });
    cpSync(packet.observed.directory, join(preserved, "native"), { recursive: true, errorOnExist: true, force: false });
    cpSync(packet.capture.frames, join(preserved, "capture"), { recursive: true, errorOnExist: true, force: false });
    writeFileSync(join(preserved, "evidence.json"), JSON.stringify({ ...packet,
      fixture: { surface, document: "page", expectedText: EXPECTED } }, null, 2) + "\n");
    t.diagnostic(`${app.name}: original document reference evidence retained at ${preserved}`);

    const { observed, host, capture } = packet;
    assert.equal(Object.hasOwn(packet, "verified"), false, "wire collection must not label content verified");
    assert.equal(observed.schemaVersion, 1);
    assert.equal(observed.requestId, 1);
    assert.deepEqual(observed.target, { surface, document: "page" });
    assert.ok(Number.isSafeInteger(observed.generation) && observed.generation > 0);
    assert.equal(observed.producer.provider, "browser.controlled-page");
    assert.equal(observed.producer.sourceKind, "native-document");
    const actualText = observed.producer.glyphRuns.map(run => run.text).join("");
    assert.equal(actualText, EXPECTED, "the actual producer semantic text differs from the fixture criterion");
    assert.equal(observed.source.file, "native.png");
    assert.equal(observed.source.format, "PNG");
    assert.equal(observed.source.identity.generation, String(observed.generation));
    assert.equal(observed.source.identity.raster, "18446744073709551615");
    assert.match(observed.source.identity.region, /^[0-9a-f]{32}$/);
    const nativePath = join(observed.directory, observed.source.file);
    const bytes = readFileSync(nativePath), png = readPng(nativePath);
    assert.equal(bytes.length, observed.source.byteCount);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), observed.source.sha256);
    assert.equal(png.width, observed.source.width);
    assert.equal(png.height, observed.source.height);
    const actualDocument = host.documents.filter(row => row.surface === surface && row.document === "page" && row.visible);
    assert.equal(actualDocument.length, 1, "the native reference target is absent or ambiguous in public host geometry");
    const document = actualDocument[0];
    assert.deepEqual(observed.source.rectPt, { ...document.frame,
      x: host.frame.x + document.frame.x, y: host.frame.y + document.frame.y },
    "actual native source global geometry differs from its exact public host document");

    assert.equal(capture.limited, false, "reference recording reached its bounded limit");
    const files = frames(capture.frames);
    assert.equal(files.length, capture.count);
    assert.ok(files.length > 0, "reference recording retained no actual frame");
    const manifest = readJson(join(capture.frames, "frame-identities", "manifest.json"));
    const decodedRows = readRows(join(capture.frames, "frame-identities", "decoded-frames.jsonl"));
    verifyDocumentFrameIdentityCapture({ start: observed.identityStart, stop: capture, manifest, decodedRows,
      surface, generation: observed.generation });
    const matched = decodedRows.filter(row => row.sourceKind === "document" && row.status === "matched"
      && row.reason === null && row.region === observed.source.identity.region
      && tuple(row.identity) === tuple(observed.source.identity));
    assert.ok(matched.length > 0, "no actual SCK document frame carries the native snapshot's decoded issued tuple");
    t.diagnostic(`${app.name}: collected ${files.length} reference frames; ${matched.length} exact tuple rows; selected-pixel association remains a separate verifier`);
  });
}
