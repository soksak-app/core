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
    cursor: { frame, render, row: 0, col: 2, focused: true, preedit: "", shape: "beam", visible: false, blinkVisible: false },
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
      width: 12, height: 12, stride: 48, pixelFormat: "BGRA8", alpha: "premultiplied-first",
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

// The clip is an explicit native viewport observation in content points. An
// edge guard proves a boundary; it never substitutes invented offscreen pixels.
function viewportEdgeFixture() {
  const input = fixture();
  const { reference, frames } = input;
  const raster = reference.source.raster;
  reference.screen.rows[1] = [{ ch: "A", width: 1 }, { ch: "B", width: 1 }, { width: 1 }];
  const glyph = reference.source.render.glyphs[0];
  reference.source.render.glyphs = [{ ...structuredClone(glyph), col: 0 }, { ...glyph, col: 1, grapheme: "B" }];
  for (const y of [7, 8]) for (const x of [1, 2]) raster.data.set([0, 0, 255, 255], (y * 12 + x) * 4);
  reference.expected = { text: "AB", row: 1, startColumn: 0,
    guards: [{ row: 1, edge: "left", column: 0 }, { row: 1, column: 2 }] };
  reference.region.clipRectPt = { ...reference.region.rectPt };
  const fillCapture = (capture, at) => {
    capture.data.fill(255);
    for (let y = 0; y < 12; y++) capture.data.set(raster.data.subarray(y * 48, (y + 1) * 48), (y * 24 + at) * 4);
  };
  fillCapture(reference.capture, 0);
  for (const [index, frame] of frames.entries()) {
    frame.region.clipRectPt = { ...frame.region.rectPt };
    if (index > 0) fillCapture(frame.capture, index === 1 ? 0 : 12);
  }
  return input;
}

test("terminal reference preserves the complete column-zero text using an explicit native viewport edge and full right guard", { timeout: 5000 }, async () => {
  const result = await measure(viewportEdgeFixture());
  assert.equal(result.frameIndex, 2);
  assert.equal(result.proof, "verified-terminal-reference-exact-pixels");
});

const invalidViewportEdges = [
  ["edge guard away from column zero", (x) => { x.reference.expected.startColumn = 1; x.reference.expected.text = "B"; }],
  ["missing left edge guard", (x) => { x.reference.expected.guards.shift(); }],
  ["missing complete right guard", (x) => { x.reference.expected.guards.pop(); }],
  ["invented negative-column guard", (x) => { x.reference.expected.guards[0] = { row: 1, column: -1 }; }],
  ["missing native clip observation", (x) => { delete x.reference.region.clipRectPt; }],
  ["native clip starts inside the first glyph cell", (x) => { x.reference.region.clipRectPt.x = 1; x.reference.region.clipRectPt.width = 11; }],
  ["native clip starts before the grid boundary", (x) => { x.reference.region.clipRectPt.x = -1; x.reference.region.clipRectPt.width = 13; }],
  ["native clip truncates the complete right guard", (x) => { x.reference.region.clipRectPt.width = 11; }],
  ["earlier capture has a different native clip boundary", (x) => { x.frames[2].region.clipRectPt.x += 1; x.frames[2].region.clipRectPt.width -= 1; }],
  ["QR overlaps a column-zero glyph cell", (x) => { x.reference.issuedArtifact.roi = { x: 0, y: 6, width: 1, height: 1 }; x.reference.identityRow.roi = x.reference.issuedArtifact.roi; }],
  ["QR overlaps the complete right guard", (x) => { x.reference.issuedArtifact.roi = { x: 8, y: 6, width: 1, height: 1 }; x.reference.identityRow.roi = x.reference.issuedArtifact.roi; }],
];
for (const [name, mutate] of invalidViewportEdges) {
  test(`terminal reference refuses ${name}`, { timeout: 5000 }, async () => {
    const input = viewportEdgeFixture();
    mutate(input);
    await assert.rejects(() => measure(input), (error) => error.code !== "ERR_MODULE_NOT_FOUND" &&
      /reference|frame|region|glyph|guard|cursor|geometry|anchor|QR|screen|clip|edge/i.test(error.message));
  });
}

for (const plugin of ["terminal", "term"]) {
  test(`${plugin}: verified reference selects the earliest exact normal-region pixels without requiring its later tuple`, { timeout: 5000 }, async () => {
    const result = await measure(fixture(plugin));
    assert.equal(result.frameIndex, 2);
    assert.equal(result.proof, "verified-terminal-reference-exact-pixels");
  });
}

test("issued identity manifest v1 need not declare scale when source and capture geometry prove it", { timeout: 5000 }, async () => {
  const input = fixture();
  assert.equal(Object.hasOwn(input.reference.issuedArtifact, "scale"), false);
  assert.equal((await measure(input)).frameIndex, 2);
});

const invalid = [
  ["blank reference source", (x) => { x.reference.source.raster.data.fill(255); x.reference.capture.data.fill(255); }],
  ["stale screen tuple", (x) => { x.reference.screen.frame = { ...x.reference.screen.frame, sequence: 29 }; }],
  ["missing frame association", (x) => { delete x.reference.source.frame; }],
  ["unsupported issued scale even when it matches source", (x) => { x.reference.issuedArtifact.scale = 1; }],
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

test("startup uses its pre-open native applied anchor rectangle instead of mixing fractional CSS insets with measured backing pixels", { timeout: 5000 }, async () => {
  const input = fixture();
  const reference = input.reference;
  // Actual failed Wails contract: source height 519 backing pixels, while
  // declared CSS inset arithmetic produced 518.8000000000001. Native applied
  // placement is already fitted to backing pixels before the target opens.
  const height = 519;
  const extend = (old, stride) => {
    const bytes = new Uint8Array(stride * height).fill(255);
    bytes.set(old);
    return bytes;
  };
  reference.source.raster.data = extend(reference.source.raster.data, 48);
  reference.source.raster.height = height;
  reference.source.raster.screenBounds.height = height;
  reference.source.render.pixel.height = height;
  reference.region.rectPt.height = height;
  reference.issuedArtifact.height = height;
  reference.issuedArtifact.byteCount = reference.source.raster.data.length;
  const capture = { ...reference.capture, height, data: extend(reference.capture.data, 96),
    screenRect: { ...reference.capture.screenRect, height }, contentRect: { ...reference.capture.contentRect, height } };
  reference.capture = capture;
  const frames = [
    { capture: { ...capture, data: new Uint8Array(capture.data.length).fill(255) } },
    { capture },
  ];
  const geometryFrames = frames.map((_, index) => ({ timeMs: index + 1,
    cardRectPt: { left: 0, top: 0, right: 12, bottom: height } }));
  const { firstTerminalReferenceStartFrame } = await import("../terminal-reference-content.mjs");
  const result = firstTerminalReferenceStartFrame({ reference,
    target: { card: "predeclared-card", surface: reference.surface }, frames, geometryFrames,
    slotInsetsPt: { left: 0, top: 0, right: 0, bottom: 0.2 },
    anchorNativeRectPt: { x: 0, y: 0, width: 12, height },
    anchorPresentedAtMs: 0.5, targetRequestAtMs: 1.5 });
  assert.equal(result.anchorFrameIndex, 0);
  assert.equal(result.frameIndex, 1);
  assert.equal(result.proof, "verified-terminal-reference-start-exact-pixels");
});
