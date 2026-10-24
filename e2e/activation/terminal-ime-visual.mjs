import assert from "node:assert/strict";

function frameIdentity(frame, label) {
  assert.ok(frame && Number.isInteger(frame.generation) && frame.generation > 0,
    `${label} generation must be a positive integer`);
  assert.ok(Number.isInteger(frame.raster) && frame.raster > 0, `${label} raster must be a positive integer`);
  assert.ok(Number.isInteger(frame.sequence) && frame.sequence > 0, `${label} sequence must be a positive integer`);
  return `${frame.generation}/${frame.raster}/${frame.sequence}`;
}

function sameState(actual, expected) {
  try { assert.deepEqual(actual, expected); return true; } catch { return false; }
}

function validateSemanticState(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: expected semantic state is required`);
  assert.ok(typeof value.document === "string", `${label}: document text is required`);
  const compose = value.compose;
  assert.ok(compose && typeof compose === "object" && !Array.isArray(compose) && typeof compose.text === "string" &&
    Object.hasOwn(compose, "markedRange") && Object.hasOwn(compose, "selectedRange"),
  `${label}: complete composition state is required`);
  for (const key of ["markedRange", "selectedRange"]) {
    const range = compose[key];
    assert.ok(range === null || (range && Number.isSafeInteger(range.location) && range.location >= 0 &&
      Number.isSafeInteger(range.length) && range.length >= 0), `${label}: composition ${key} is invalid`);
  }
  const cursor = value.cursor;
  assert.ok(cursor && typeof cursor === "object" && !Array.isArray(cursor) &&
    Number.isInteger(cursor.row) && cursor.row >= 0 && Number.isInteger(cursor.col) &&
    cursor.col >= 0 && typeof cursor.focused === "boolean" && typeof cursor.preedit === "string",
  `${label}: complete cursor and focus state is required`);
  const geometry = value.geometry;
  assert.ok(geometry && typeof geometry === "object" && !Array.isArray(geometry) &&
    Number.isInteger(geometry.rows) && geometry.rows > 0 &&
    Number.isInteger(geometry.cols) && geometry.cols > 0 && Number.isInteger(geometry.cellWidth) &&
    geometry.cellWidth > 0 && Number.isInteger(geometry.cellHeight) && geometry.cellHeight > 0 &&
    Number.isInteger(geometry.origin?.x) && geometry.origin.x >= 0 &&
    Number.isInteger(geometry.origin?.y) && geometry.origin.y >= 0,
  `${label}: complete cell geometry is required`);
  return value;
}

function validateCapture(capture) {
  assert.ok(capture && Number.isInteger(capture.width) && capture.width > 0 &&
    Number.isInteger(capture.height) && capture.height > 0 && Number.isInteger(capture.bytesPerRow) &&
    capture.bytesPerRow >= capture.width * 4 && capture.data instanceof Uint8Array &&
    capture.data.length === capture.bytesPerRow * capture.height,
  "capture pixel dimensions, stride, or storage are invalid");
  assert.ok(Number.isFinite(capture.scaleFactor) && capture.scaleFactor > 0,
    "capture scale factor is invalid");
  const screen = capture.screenRect;
  const content = capture.contentRect;
  assert.ok(screen && [screen.x, screen.y, screen.width, screen.height].every(Number.isFinite) &&
    screen.width > 0 && screen.height > 0 &&
    Math.abs(screen.width * capture.scaleFactor - capture.width) < 1e-7 &&
    Math.abs(screen.height * capture.scaleFactor - capture.height) < 1e-7,
  "capture screen bounds do not match its pixel dimensions");
  assert.ok(content && [content.x, content.y, content.width, content.height].every(Number.isFinite) &&
    content.x >= 0 && content.y >= 0 && content.width > 0 && content.height > 0 &&
    content.x + content.width <= screen.width && content.y + content.height <= screen.height,
  "capture content bounds are outside the image");
}

function cropCell(raster, cell, label) {
  const { width, height, data, grid, bytesPerRow = width * 4 } = raster;
  assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0,
    `${label}: raster dimensions are invalid`);
  assert.ok(grid && Number.isInteger(grid.cols) && grid.cols > 0 && Number.isInteger(grid.rows) && grid.rows > 0 &&
    Number.isInteger(grid.cellWidth) && grid.cellWidth > 0 && Number.isInteger(grid.cellHeight) &&
    grid.cellHeight > 0 && Number.isInteger(grid.x) && grid.x >= 0 && Number.isInteger(grid.y) && grid.y >= 0,
  `${label}: integer cell-grid geometry is required`);
  assert.equal(raster.format, "BGRA8", `${label}: raster format must be BGRA8`);
  assert.equal(raster.alpha, "premultiplied-first", `${label}: raster alpha mode is unsupported`);
  assert.equal(raster.colorSpace, "sRGB", `${label}: raster color space is unsupported`);
  assert.ok(Number.isInteger(bytesPerRow) && bytesPerRow >= width * 4 &&
    data instanceof Uint8Array && data.length === bytesPerRow * height,
  `${label}: raster byte stride or storage is invalid`);
  assert.ok(grid.x + grid.cols * grid.cellWidth <= width && grid.y + grid.rows * grid.cellHeight <= height,
    `${label}: cell grid is outside the raster`);
  assert.ok(Number.isInteger(cell.row) && cell.row >= 0 && cell.row < grid.rows,
    `${label}: cell row is outside the grid`);
  assert.ok(Number.isInteger(cell.column) && cell.column >= 0 && cell.column < grid.cols,
    `${label}: cell column is outside the grid`);
  const { cellWidth, cellHeight } = grid;
  const x = grid.x + cell.column * cellWidth;
  const y = grid.y + cell.row * cellHeight;
  const bytes = new Uint8Array(cellWidth * cellHeight * 4);
  for (let row = 0; row < cellHeight; row++) {
    const from = (y + row) * bytesPerRow + x * 4;
    bytes.set(data.subarray(from, from + cellWidth * 4), row * cellWidth * 4);
  }
  return { width: cellWidth, height: cellHeight, bytes };
}

function cropCells(raster, cells, label) {
  assert.ok(Array.isArray(cells) && cells.length > 0, `${label}: input and guard cells are required`);
  const crops = cells.map((cell) => cropCell(raster, cell, label));
  const height = crops[0].height;
  assert.ok(crops.every((crop) => crop.height === height), `${label}: input cells have different heights`);
  const width = crops.reduce((sum, crop) => sum + crop.width, 0);
  const bytes = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    let offset = row * width * 4;
    for (const crop of crops) {
      const rowBytes = crop.width * 4;
      bytes.set(crop.bytes.subarray(row * rowBytes, (row + 1) * rowBytes), offset);
      offset += rowBytes;
    }
  }
  return { width, height, bytes };
}

function cropRect(raster, rect, label) {
  const { width, height, data, bytesPerRow = width * 4 } = raster;
  assert.ok([rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) &&
    rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
    rect.x + rect.width <= width && rect.y + rect.height <= height,
  `${label}: mapped crop is offscreen or fractional`);
  const bytes = new Uint8Array(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row++) {
    const from = (rect.y + row) * bytesPerRow + rect.x * 4;
    bytes.set(data.subarray(from, from + rect.width * 4), row * rect.width * 4);
  }
  return { width: rect.width, height: rect.height, bytes };
}

function captureCells(capture, source, cells) {
  validateCapture(capture);
  assert.equal(capture.format, source.format, "capture/source pixel formats differ");
  assert.equal(capture.alpha, source.alpha, "capture/source alpha modes differ");
  assert.equal(capture.colorSpace, source.colorSpace, "capture/source color spaces differ");
  assert.equal(capture.scaleFactor, source.scale, "capture/source pixel scales differ");
  const screen = capture.screenRect;
  const content = capture.contentRect;
  const bounds = source.screenBounds;
  assert.ok([screen?.x, screen?.y, screen?.width, screen?.height, content?.x, content?.y,
    bounds?.x, bounds?.y, bounds?.width, bounds?.height].every(Number.isFinite),
  "capture/source screen geometry is missing");
  const grid = source.grid;
  assert.equal(bounds.width * source.scale, source.width, "source raster width differs from its screen bounds");
  assert.equal(bounds.height * source.scale, source.height, "source raster height differs from its screen bounds");
  const crops = cells.map((cell) => {
    const x = (content.x + bounds.x - screen.x +
      (grid.x + cell.column * grid.cellWidth) / source.scale) * capture.scaleFactor;
    const y = (content.y + bounds.y - screen.y +
      (grid.y + cell.row * grid.cellHeight) / source.scale) * capture.scaleFactor;
    const width = grid.cellWidth / source.scale * capture.scaleFactor;
    const height = grid.cellHeight / source.scale * capture.scaleFactor;
    assert.ok([x, y, width, height].every(Number.isInteger), "capture cell mapping is fractional");
    return cropRect(capture, { x, y, width, height }, "capture");
  });
  const height = crops[0].height;
  assert.ok(crops.every((crop) => crop.height === height), "capture input cells have different heights");
  const width = crops.reduce((sum, crop) => sum + crop.width, 0);
  const bytes = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    let offset = row * width * 4;
    for (const crop of crops) {
      const count = crop.width * 4;
      bytes.set(crop.bytes.subarray(row * count, (row + 1) * count), offset);
      offset += count;
    }
  }
  return { width, height, bytes };
}

function sameBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function compositionFrameCandidates({ targetFrame, capture, sources, cells, cell, expectedState }) {
  const target = frameIdentity(targetFrame, "terminal.cursor.frame");
  const expected = validateSemanticState(expectedState, "expected");
  const span = cells ?? [cell];
  const candidates = [];
  const sourceIdentities = new Set();
  for (const source of sources) {
    const identity = frameIdentity(source.frame, "source frame");
    assert.ok(!sourceIdentities.has(identity), `source identity ${identity} is duplicated`);
    sourceIdentities.add(identity);
    const sourceCrop = cropCells(source.raster, span, `source ${identity}`);
    const capturedCrop = captureCells(capture, source.raster, span);
    if (sourceCrop.width !== capturedCrop.width || sourceCrop.height !== capturedCrop.height ||
        !sameBytes(sourceCrop.bytes, capturedCrop.bytes)) continue;
    assert.ok(source.state?.frame, `source ${identity}: same-frame status identity is missing`);
    assert.equal(frameIdentity(source.state.frame, `source ${identity} status`), identity,
      `source ${identity}: status belongs to a different frame`);
    assert.ok(source.state.semantic, `source ${identity}: same-frame semantic state is missing`);
    const semantic = validateSemanticState(source.state.semantic, `source ${identity}`);
    assert.deepEqual(semantic.geometry, {
      rows: source.raster.grid.rows,
      cols: source.raster.grid.cols,
      cellWidth: source.raster.grid.cellWidth,
      cellHeight: source.raster.grid.cellHeight,
      origin: { x: source.raster.grid.x, y: source.raster.grid.y },
    }, `source ${identity}: semantic geometry differs from its raster`);
    candidates.push({ identity, stateMatches: sameState(semantic, expected) });
  }
  const targetPresent = candidates.some(({ identity }) => identity === target);
  const semanticMismatch = candidates.some(({ stateMatches }) => !stateMatches);
  return {
    result: targetPresent && candidates.length > 0 && !semanticMismatch ? "candidate-set" : "no-proof",
    target,
    identities: candidates.map(({ identity }) => identity),
    ambiguous: candidates.length > 1,
    reasons: [
      ...(!targetPresent ? ["target-frame-not-in-roi-candidates"] : []),
      ...(candidates.length === 0 ? ["no-roi-candidate"] : []),
      ...(semanticMismatch ? ["candidate-semantic-state-differs"] : []),
    ],
  };
}

function rgbDistance(pixel, color) {
  return Math.max(Math.abs(pixel[0] - color[0]), Math.abs(pixel[1] - color[1]), Math.abs(pixel[2] - color[2]));
}

export function validateRenderMetadata(render, cursorFrame, cursor, expectedGlyphs = []) {
  if (render === null) return { result: "no-proof", reason: "renderer-metadata-unavailable" };
  assert.ok(render && typeof render === "object" && !Array.isArray(render),
    "renderer metadata must be null or an object");
  const frame = frameIdentity(cursorFrame, "terminal.cursor.frame");
  assert.equal(frameIdentity(render.frame, "terminal.cursor.render.frame"), frame,
    "renderer metadata belongs to a different frame");
  const pixel = render.pixel;
  assert.ok(pixel && Number.isInteger(pixel.width) && pixel.width > 0 &&
    Number.isInteger(pixel.height) && pixel.height > 0, "renderer pixel dimensions are invalid");
  assert.ok(Number.isInteger(pixel.bytesPerRow) && pixel.bytesPerRow >= pixel.width * 4,
    "renderer pixel stride is invalid");
  assert.equal(pixel.format, "BGRA8", "renderer pixel format must be BGRA8");
  assert.equal(pixel.alpha, "premultiplied-first", "renderer alpha mode is unsupported");
  assert.equal(pixel.colorSpace, "sRGB", "renderer color space is unsupported");
  assert.equal(pixel.origin, "top-left", "renderer pixel origin must be top-left");
  const grid = render.grid;
  assert.ok(grid && Number.isInteger(grid.rows) && grid.rows > 0 &&
    Number.isInteger(grid.cols) && grid.cols > 0 && Number.isInteger(grid.cellWidth) && grid.cellWidth > 0 &&
    Number.isInteger(grid.cellHeight) && grid.cellHeight > 0 && Number.isInteger(grid.origin?.x) &&
    grid.origin.x >= 0 && Number.isInteger(grid.origin?.y) && grid.origin.y >= 0,
  "renderer grid geometry is invalid");
  assert.ok(grid.origin.x + grid.cols * grid.cellWidth <= pixel.width &&
    grid.origin.y + grid.rows * grid.cellHeight <= pixel.height, "renderer grid is outside the pixel frame");
  const font = render.font;
  assert.ok(font && typeof font.family === "string" && font.family.length > 0 &&
    [font.size, font.ascent, font.descent, font.leading].every(Number.isFinite) && font.size > 0,
  "renderer font metrics are invalid");
  const underline = render.underline?.rect;
  assert.ok(underline && [underline.x, underline.y, underline.width, underline.height].every(Number.isFinite) &&
    underline.width > 0 && underline.height > 0 &&
    render.underline.colorSource === "cell.foregroundAfterInverse",
  "renderer underline rectangle or color source is invalid");
  rasterizeCellBounds(underline, grid.cellWidth, grid.cellHeight, "renderer underline rectangle");
  assert.ok(Array.isArray(render.glyphs), "renderer glyph bounds are missing");
  for (const glyph of render.glyphs) {
    assert.ok(Number.isInteger(glyph.row) && glyph.row >= 0 && glyph.row < grid.rows &&
      Number.isInteger(glyph.col) && glyph.col >= 0 && glyph.col < grid.cols &&
      typeof glyph.grapheme === "string" && glyph.grapheme.length > 0,
    "renderer glyph identity is invalid");
    const bounds = glyph.bounds;
    assert.ok(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
      bounds.width > 0 && bounds.height > 0,
    "renderer glyph ink rectangle is invalid");
    rasterizeCellBounds(bounds, grid.cellWidth, grid.cellHeight, "renderer glyph bounds");
  }
  for (const expected of expectedGlyphs) {
    assert.ok(render.glyphs.some((glyph) => glyph.row === expected.row && glyph.col === expected.col &&
      glyph.grapheme === expected.grapheme),
    `renderer glyph bounds are missing for ${JSON.stringify(expected)}`);
  }
  const renderedCursor = render.cursor;
  assert.ok(cursor && typeof cursor.shape === "string" &&
    [cursor.focused, cursor.visible, cursor.blinkVisible].every((value) => typeof value === "boolean"),
  "terminal cursor state is incomplete");
  assert.ok(renderedCursor && ["x", "y", "width", "height"].every((key) =>
    Number.isInteger(renderedCursor.rect?.[key])), "renderer cursor rectangle is missing");
  assert.equal(renderedCursor.shape, cursor.shape, "renderer cursor shape differs from terminal status");
  for (const field of ["focused", "visible", "blinkVisible"]) {
    assert.equal(renderedCursor[field], cursor[field], `renderer cursor ${field} differs from terminal status`);
  }
  assert.ok(["difference", "normal"].includes(renderedCursor.blend), "renderer cursor blend is unsupported");
  assert.ok(renderedCursor.rect.x >= 0 && renderedCursor.rect.y >= 0 && renderedCursor.rect.width > 0 &&
    renderedCursor.rect.height > 0 && renderedCursor.rect.x + renderedCursor.rect.width <= pixel.width &&
    renderedCursor.rect.y + renderedCursor.rect.height <= pixel.height,
  "renderer cursor rectangle is outside the frame");
  return { result: "declared", frame };
}

/** Maps a floating renderer rect to covered pixels, then clips it to the owning cell. */
export function rasterizeCellBounds(bounds, cellWidth, cellHeight, label = "renderer bounds") {
  assert.ok(Number.isInteger(cellWidth) && cellWidth > 0 && Number.isInteger(cellHeight) && cellHeight > 0,
    `${label}: cell dimensions must be positive integers`);
  assert.ok(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width > 0 && bounds.height > 0, `${label}: floating rectangle is invalid`);
  const left = Math.max(0, Math.floor(bounds.x));
  const top = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(cellWidth, Math.ceil(bounds.x + bounds.width));
  const bottom = Math.min(cellHeight, Math.ceil(bounds.y + bounds.height));
  assert.ok(right > left && bottom > top, `${label}: rectangle covers no cell pixels`);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function measureRenderedCell(cellPixels, render, target, cellColors, criteria) {
  if (render === null) return { result: "no-proof", reason: "renderer-metadata-unavailable" };
  assert.ok(target?.frame && target.cursor, "frame-bound terminal cursor state is required");
  validateRenderMetadata(render, target.frame, target.cursor,
    [{ row: target.row, col: target.col, grapheme: target.grapheme }]);
  const glyph = render?.glyphs?.find((entry) => entry.row === target.row && entry.col === target.col &&
    entry.grapheme === target.grapheme);
  if (!glyph || !render.underline?.rect) {
    return { result: "no-proof", reason: "same-frame-glyph-or-underline-metrics-missing" };
  }
  const { width, height, bytes } = cellPixels;
  const { cellWidth, cellHeight } = render.grid;
  const gridX = render.grid.origin.x;
  const gridY = render.grid.origin.y;
  assert.ok(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    bytes instanceof Uint8Array && bytes.length === width * height * 4,
  "cell pixels must be tightly packed BGRA8");
  assert.equal(width, cellWidth, "cell crop width differs from renderer grid");
  assert.equal(height, cellHeight, "cell crop height differs from renderer grid");
  const validColor = (color) => Array.isArray(color) && color.length === 3 &&
    color.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
  assert.ok(validColor(cellColors.foreground) && validColor(cellColors.background),
    "resolved cell foreground and background are required");
  assert.equal(typeof target.marked, "boolean", "cell marked state is required");
  const glyphRect = rasterizeCellBounds(glyph.bounds, cellWidth, cellHeight, "glyph bounds");
  const underlineRect = rasterizeCellBounds(render.underline.rect, cellWidth, cellHeight, "underline bounds");
  assert.ok(Number.isInteger(criteria.colorDistance) && criteria.colorDistance > 0,
    "consumer colorDistance must be positive");
  assert.ok(Number.isInteger(criteria.minimumGlyphPixels) && criteria.minimumGlyphPixels > 0,
    "consumer minimumGlyphPixels must be positive");
  assert.ok(Number.isFinite(criteria.minimumUnderlineCoverage) && criteria.minimumUnderlineCoverage > 0 &&
    criteria.minimumUnderlineCoverage <= 1, "consumer minimumUnderlineCoverage must be in (0, 1]");
  const cursor = render.cursor;
  const isCursorPixel = (x, y) => cursor.visible && cursor.blinkVisible &&
    x + gridX + target.col * cellWidth >= cursor.rect.x &&
    x + gridX + target.col * cellWidth < cursor.rect.x + cursor.rect.width &&
    y + gridY + target.row * cellHeight >= cursor.rect.y &&
    y + gridY + target.row * cellHeight < cursor.rect.y + cursor.rect.height;
  const matchesForeground = (pixel, x, y) => {
    const inverse = isCursorPixel(x, y) && cursor.shape === "block" && cursor.blend === "difference";
    const foreground = inverse ? cellColors.foreground.map((channel) => 255 - channel) : cellColors.foreground;
    const background = inverse ? cellColors.background.map((channel) => 255 - channel) : cellColors.background;
    return rgbDistance(pixel, foreground) < criteria.colorDistance &&
      rgbDistance(pixel, background) >= criteria.colorDistance;
  };
  let ink = 0;
  for (let y = glyphRect.y; y < glyphRect.y + glyphRect.height; y++) {
    for (let x = glyphRect.x; x < glyphRect.x + glyphRect.width; x++) {
      if (x >= underlineRect.x && x < underlineRect.x + underlineRect.width &&
          y >= underlineRect.y && y < underlineRect.y + underlineRect.height) continue;
      const offset = (y * width + x) * 4;
      const pixel = [bytes[offset + 2], bytes[offset + 1], bytes[offset]];
      const inCursor = isCursorPixel(x, y);
      if (inCursor && (cursor.shape !== "block" || cursor.blend !== "difference")) {
        return { result: "no-proof", reason: "glyph-overlaps-unsupported-cursor" };
      }
      if (matchesForeground(pixel, x, y)) ink++;
    }
  }
  let underlineCoverage = 0;
  for (let y = underlineRect.y; y < underlineRect.y + underlineRect.height; y++) {
    let run = 0;
    for (let x = underlineRect.x; x < underlineRect.x + underlineRect.width; x++) {
      const offset = (y * width + x) * 4;
      const pixel = [bytes[offset + 2], bytes[offset + 1], bytes[offset]];
      if (matchesForeground(pixel, x, y)) {
        run++;
        underlineCoverage = Math.max(underlineCoverage, run / underlineRect.width);
      } else run = 0;
    }
  }
  const underlined = underlineCoverage >= criteria.minimumUnderlineCoverage;
  const glyphPresent = ink >= criteria.minimumGlyphPixels;
  const passes = glyphPresent && underlined === target.marked;
  return { result: passes ? "measured" : "failed", glyphPixels: ink, underlineCoverage, underlined, glyphPresent };
}

