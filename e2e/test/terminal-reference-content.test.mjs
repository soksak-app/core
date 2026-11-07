import assert from "node:assert/strict";
import test from "node:test";
import renderFixture from "../activation/fixtures/screen-render.json" with { type: "json" };

// Public screen rows, renderer metadata and decoded BGRA capture DTOs; no
// glyph rasterizer, capture codec, OCR or per-frame semantic inheritance.
function fixture(plugin = "terminal") {
  const frame = { generation: 1, raster: 2, sequence: 30 };
  const region = { surface: "terminal-tab", name: "view", regionToken: "00112233445566778899aabbccddeeff" };
  const render = structuredClone(renderFixture);
  render.frame = frame;
  render.pixel = { ...render.pixel, width: 12, height: 12, bytesPerRow: 48 };
  render.grid = { rows: 2, cols: 3, origin: { x: 0, y: 0 }, cellWidth: 4, cellHeight: 6 };
  render.glyphs = [{ ...render.glyphs[0], row: 1, col: 1, grapheme: "A", fontRuns: 1,
    bounds: { x: 1, y: 1, width: 2, height: 2 }, underline: { rect: null } }];
  const pixels = new Uint8Array(12 * 12 * 4).fill(255);
  for (const y of [7, 8]) for (const x of [5, 6]) pixels.set([0, 0, 255, 255], (y * 12 + x) * 4);
  const capture = (at, content = pixels) => {
    const data = new Uint8Array(24 * 12 * 4).fill(255);
    for (let y = 0; y < 12; y++) data.set(content.subarray(y * 48, (y + 1) * 48), (y * 24 + at) * 4);
    return { width: 24, height: 12, bytesPerRow: 96, data, format: "BGRA8", alpha: "premultiplied-first",
      colorSpace: "sRGB", scaleFactor: 1, screenRect: { x: 0, y: 0, width: 24, height: 12 },
      contentRect: { x: 0, y: 0, width: 24, height: 12 } };
  };
  const placed = (at) => ({ ...region, rectPt: { x: at, y: 0, width: 12, height: 12 } });
  const reference = {
    plugin, ...region,
    screen: { frame, rows: [[{ width: 1 }, { width: 1 }, { width: 1 }],
      [{ width: 1 }, { ch: "A", width: 1 }, { width: 1 }]] },
    cursor: { frame, render, row: 1, col: 2, focused: true, preedit: "", shape: "beam", visible: false, blinkVisible: false },
    source: { frame, regionToken: region.regionToken, render, raster: {
      width: 12, height: 12, bytesPerRow: 48, data: pixels, format: "BGRA8", alpha: "premultiplied-first",
      colorSpace: "sRGB", scale: 1, screenBounds: { x: 0, y: 0, width: 12, height: 12 },
      grid: { rows: 2, cols: 3, cellWidth: 4, cellHeight: 6, x: 0, y: 0 },
    } },
    capture: capture(0), region: placed(0),
    identityRow: { frame: 1, displayTime: "900000000", status: "matched", reason: null,
      region: region.regionToken, identity: { generation: "1", raster: "2", sequence: 30 },
      roi: { x: 0, y: 0, width: 1, height: 1 } },
    issuedArtifact: { regionToken: region.regionToken, generation: "1", raster: "2", sequence: 30,
      width: 12, height: 12, stride: 48, scale: 1, pixelFormat: "BGRA8", alpha: "premultiplied-first",
      colorSpace: "sRGB", byteCount: pixels.byteLength,
      roi: { x: 0, y: 0, width: 1, height: 1 } },
    expected: { text: "A", row: 1, startColumn: 1,
      guards: [{ row: 1, column: 0 }, { row: 1, column: 2 }] },
    criteria: { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 },
  };
  const frames = [
    { capture: capture(0, new Uint8Array(pixels.length).fill(255)), region: placed(0) },
    // Correct pixels elsewhere in the window are not content of this region.
    { capture: capture(0), region: placed(12) },
    { capture: capture(12), region: placed(12) },
    { capture: capture(12), region: placed(12) },
  ];
  return { reference, frames, anchorFrameIndex: 0 };
}

async function measure(input) {
  const { firstTerminalReferenceContentFrame } = await import("../terminal-reference-content.mjs");
  return firstTerminalReferenceContentFrame(input);
}

for (const plugin of ["terminal", "term"]) {
  test(`${plugin}: verified reference selects the earliest exact normal-region pixels without requiring its later tuple`, { timeout: 5000 }, async () => {
    const result = await measure(fixture(plugin));
    assert.equal(result.frameIndex, 2);
    assert.equal(result.proof, "verified-terminal-reference-exact-pixels");
  });
}

const invalid = [
  ["blank reference source", (x) => { x.reference.source.raster.data.fill(255); x.reference.capture.data.fill(255); }],
  ["stale screen tuple", (x) => { x.reference.screen.frame = { ...x.reference.screen.frame, sequence: 29 }; }],
  ["missing frame association", (x) => { delete x.reference.source.frame; }],
  ["different source region", (x) => { x.reference.source.regionToken = "another-region"; }],
  ["wrong decoded region", (x) => { x.reference.identityRow.region = "another-region"; }],
  ["QR overlaps a complete guard cell", (x) => { x.reference.issuedArtifact.roi = { x: 0, y: 6, width: 1, height: 1 }; x.reference.identityRow.roi = x.reference.issuedArtifact.roi; }],
  ["unsupported cursor covers expected glyph", (x) => { Object.assign(x.reference.source.render.cursor,
    { rect: { x: 4, y: 6, width: 4, height: 6 }, visible: true, blinkVisible: true, shape: "beam", color: "#ff0000" }); }],
  ["missing expected glyph metadata", (x) => { x.reference.source.render.glyphs = []; }],
  ["missing guard cells", (x) => { x.reference.expected.guards = []; }],
  ["missing per-frame region geometry", (x) => { delete x.frames[1].region.rectPt; }],
  ["anchor already contains correct pixels", (x) => { x.frames[0] = structuredClone(x.frames[2]); }],
  ["expected text absent from reference rows", (x) => { x.reference.screen.rows[1][1].ch = "B"; }],
];
for (const [name, mutate] of invalid) {
  test(`terminal reference refuses ${name}`, { timeout: 5000 }, async () => {
    const input = fixture();
    mutate(input);
    await assert.rejects(() => measure(input), (error) => error.code !== "ERR_MODULE_NOT_FOUND" &&
      /reference|frame|region|glyph|guard|cursor|geometry|anchor|QR|screen/i.test(error.message));
  });
}
