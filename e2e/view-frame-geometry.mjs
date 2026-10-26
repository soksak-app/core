import { pixel } from "@soksak/window-check/frame.mjs";

export const VIEW_GEOMETRY_COLOR_TOLERANCE = 4;
const DEFAULT_TOLERANCE = VIEW_GEOMETRY_COLOR_TOLERANCE;

function requireColor(value, name) {
  if (!Array.isArray(value) || value.length !== 3 ||
      !value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
    throw new Error(`${name} must be an RGB byte triplet`);
  }
  return value;
}

function near(actual, expected, tolerance) {
  return actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);
}

function nearAt(frame, x, y, color, tolerance) {
  const offset = y * frame.stride + x * 4;
  return Math.abs(frame.data[offset + 2] - color[0]) <= tolerance &&
    Math.abs(frame.data[offset + 1] - color[1]) <= tolerance &&
    Math.abs(frame.data[offset] - color[2]) <= tolerance;
}

function rectPoint(rect, frame) {
  const scale = frame.scale * frame.contentScale;
  const xOrigin = frame.content.x * frame.scale;
  const yOrigin = frame.content.y * frame.scale;
  return Object.fromEntries(Object.entries(rect).map(([edge, value]) => [
    edge,
    (value - (edge === "left" || edge === "right" ? xOrigin : yOrigin)) / scale,
  ]));
}

function contentRectangle(frame, color, tolerance, cardRect) {
  const runs = [];
  let previous = [];
  const root = (id) => {
    let current = id;
    while (runs[current].parent !== current) {
      runs[current].parent = runs[runs[current].parent].parent;
      current = runs[current].parent;
    }
    return current;
  };
  const join = (left, right) => {
    const a = root(left), b = root(right);
    if (a !== b) runs[b].parent = a;
  };
  for (let y = 0; y < frame.height; y++) {
    const current = [];
    let priorIndex = 0;
    for (let x = 0; x < frame.width; x++) {
      const offset = y * frame.stride + x * 4;
      if (frame.data[offset + 3] !== 255 || !nearAt(frame, x, y, color, tolerance)) continue;
      const left = x;
      while (x + 1 < frame.width) {
        const next = (y * frame.stride) + (x + 1) * 4;
        if (frame.data[next + 3] !== 255 || !nearAt(frame, x + 1, y, color, tolerance)) break;
        x++;
      }
      const id = runs.length;
      runs.push({ parent: id, left, top: y, right: x + 1, bottom: y + 1, pixels: x - left + 1 });
      current.push(id);
      while (priorIndex < previous.length && runs[previous[priorIndex]].right <= left) priorIndex++;
      for (let index = priorIndex; index < previous.length && runs[previous[index]].left < x + 1; index++) {
        join(id, previous[index]);
      }
    }
    previous = current;
  }
  if (runs.length === 0) throw new Error("recorded frame has no opaque content-color pixels");
  const components = new Map();
  for (const [id, run] of runs.entries()) {
    const key = root(id);
    const component = components.get(key) ?? {
      left: frame.width, top: frame.height, right: 0, bottom: 0, pixels: 0,
    };
    component.left = Math.min(component.left, run.left);
    component.top = Math.min(component.top, run.top);
    component.right = Math.max(component.right, run.right);
    component.bottom = Math.max(component.bottom, run.bottom);
    component.pixels += run.pixels;
    components.set(key, component);
  }
  const ordered = [...components.values()].sort((left, right) => right.pixels - left.pixels);
  const selected = cardRect
    ? ordered.filter((component) => component.left < cardRect.right && component.right > cardRect.left
      && component.top < cardRect.bottom && component.bottom > cardRect.top)
    : ordered;
  if (cardRect && selected.length === 0) throw new Error("recorded target card has no opaque content-color pixels");
  if (!cardRect && selected.length > 1 && selected.slice(1).some((component) =>
    component.left < selected[0].left || component.top < selected[0].top
      || component.right > selected[0].right || component.bottom > selected[0].bottom)) {
    throw new Error("recorded frame has a separate opaque content-color region outside the measured rectangle");
  }
  const left = Math.min(...selected.map((component) => component.left));
  const top = Math.min(...selected.map((component) => component.top));
  const right = Math.max(...selected.map((component) => component.right));
  const bottom = Math.max(...selected.map((component) => component.bottom));
  const pixels = selected.reduce((sum, component) => sum + component.pixels, 0);
  if (pixels < 4 || right - left < 2 || bottom - top < 2) {
    throw new Error("recorded content-color pixels do not identify a rectangle");
  }
  return { left, top, right, bottom };
}

function cardRectangle(frame, content, { planeColor, cardColor, borderColors, tolerance }) {
  const x = Math.floor((content.left + content.right - 1) / 2);
  const y = Math.floor((content.top + content.bottom - 1) / 2);
  const isPlane = (px, py) => nearAt(frame, px, py, planeColor, tolerance);
  const isCard = (px, py) => nearAt(frame, px, py, cardColor, tolerance);
  const isBorder = (px, py) => borderColors.some((color) => nearAt(frame, px, py, color, tolerance));
  if (isPlane(x, y)) throw new Error("recorded content center is outside the card");
  const walk = (dx, dy, edge) => {
    let px = x, py = y;
    while (!isPlane(px, py)) {
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || nx >= frame.width || ny < 0 || ny >= frame.height) {
        throw new Error(`recorded frame clips the card ${edge} edge`);
      }
      px = nx;
      py = ny;
    }
    const edgeX = px - dx, edgeY = py - dy;
    if (!isBorder(edgeX, edgeY) && !(isCard(edgeX, edgeY) && isCard(px - 2 * dx, py - 2 * dy))) {
      throw new Error(`recorded pixels do not identify the card ${edge} edge`);
    }
    return { planeX: px, planeY: py, cardX: px - dx, cardY: py - dy };
  };
  const left = walk(-1, 0, "left");
  const right = walk(1, 0, "right");
  const top = walk(0, -1, "top");
  const bottom = walk(0, 1, "bottom");
  return {
    left: left.cardX,
    top: top.cardY,
    right: right.cardX + 1,
    bottom: bottom.cardY + 1,
  };
}

/** Derives expected slot insets from declared composition geometry and the workbench card layout. */
export function declaredSlotInsets({ grid, surfaces, card: cardId, surface: surfaceId, regionRect } = {}) {
  const card = grid?.cards?.find((item) => item.id === cardId);
  const surface = surfaces?.find((item) => item.surface === surfaceId);
  const plane = grid?.plane;
  const declared = surface?.declared;
  const applied = surface?.applied;
  const finiteRect = (rect) => rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)
    && rect.w > 0 && rect.h > 0;
  if (!card || !finiteRect(card) || !plane || !Number.isFinite(plane.x) || !Number.isFinite(plane.y)
      || !finiteRect(declared)) {
    throw new Error("missing declared composition geometry for slot insets");
  }
  let expected = declared;
  if (regionRect !== undefined) {
    if (!finiteRect(applied)) throw new Error("missing applied composition geometry for nested region insets");
    if (!finiteRect(regionRect)) throw new Error("nested region DOM rectangle is invalid");
    const local = { x: regionRect.x - applied.x, y: regionRect.y - applied.y,
      w: regionRect.w, h: regionRect.h };
    expected = { x: declared.x + local.x, y: declared.y + local.y, w: local.w, h: local.h };
  }
  const cardLeft = plane.x + card.x;
  const cardTop = plane.y + card.y;
  const insets = {
    left: expected.x - cardLeft,
    top: expected.y - cardTop,
    right: cardLeft + card.w - expected.x - expected.w,
    bottom: cardTop + card.h - expected.y - expected.h,
  };
  if (!Object.values(insets).every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error(`declared slot insets are invalid: ${JSON.stringify(insets)}`);
  }
  return insets;
}

/** Finds the first recorded card change after a pre-request baseline and the first frame matching a declared slot. */
export function findFirstChangedSlotFrame(geometryFrames, { beforeChangeTimeMs, slotInsetsPt, tolerancePt = 2 } = {}) {
  if (!Array.isArray(geometryFrames) || geometryFrames.length < 2) {
    throw new Error("layout transition requires a baseline and subsequent measured frames");
  }
  if (!Number.isFinite(beforeChangeTimeMs) || beforeChangeTimeMs < 0) {
    throw new Error("layout transition requires a valid pre-change timestamp");
  }
  if (!slotInsetsPt || ![slotInsetsPt.left, slotInsetsPt.top, slotInsetsPt.right, slotInsetsPt.bottom]
    .every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("layout transition requires nonnegative declared slot insets");
  }
  if (!Number.isFinite(tolerancePt) || tolerancePt < 0) throw new Error("layout geometry tolerance is invalid");
  let previousTime = -Infinity;
  let baselineFrameIndex = -1;
  for (const [index, frame] of geometryFrames.entries()) {
    if (!Number.isFinite(frame?.timeMs) || frame.timeMs <= previousTime) {
      throw new Error(`layout geometry frame ${index} has a non-increasing timestamp`);
    }
    previousTime = frame.timeMs;
    if (!validMeasuredRect(frame.cardRectPt) || !validMeasuredRect(frame.nativeRectPt)) {
      throw new Error(`layout geometry frame ${index} has an invalid measured rectangle`);
    }
    if (frame.timeMs < beforeChangeTimeMs) baselineFrameIndex = index;
  }
  if (baselineFrameIndex < 0 || baselineFrameIndex === geometryFrames.length - 1) {
    throw new Error("layout recording does not contain both a pre-change baseline and later frames");
  }
  const baseline = geometryFrames[baselineFrameIndex].cardRectPt;
  const edges = ["left", "top", "right", "bottom"];
  const changeFrameIndex = geometryFrames.findIndex((frame, index) => index > baselineFrameIndex
    && edges.some((edge) => Math.abs(frame.cardRectPt[edge] - baseline[edge]) > tolerancePt));
  if (changeFrameIndex < 0) throw new Error("layout recording contains no pixel-measured card change");
  const slotMatchFrameIndices = [];
  let maxSlotErrorPt = 0;
  for (let index = changeFrameIndex; index < geometryFrames.length; index++) {
    const frame = geometryFrames[index];
    const expected = {
      left: frame.cardRectPt.left + slotInsetsPt.left,
      top: frame.cardRectPt.top + slotInsetsPt.top,
      right: frame.cardRectPt.right - slotInsetsPt.right,
      bottom: frame.cardRectPt.bottom - slotInsetsPt.bottom,
    };
    if (expected.right <= expected.left || expected.bottom <= expected.top) continue;
    const error = Math.max(...edges.map((edge) => Math.abs(expected[edge] - frame.nativeRectPt[edge])));
    if (error <= tolerancePt) {
      slotMatchFrameIndices.push(index);
      if (slotMatchFrameIndices.length === 1) maxSlotErrorPt = error;
    }
  }
  if (slotMatchFrameIndices.length === 0) throw new Error("layout recording has no changed frame matching the new declared slot");
  return { baselineFrameIndex, changeFrameIndex, contentFrameIndex: slotMatchFrameIndices[0],
    slotMatchFrameIndices, maxSlotErrorPt };
}

function validMeasuredRect(rect) {
  return rect && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
    && rect.right > rect.left && rect.bottom > rect.top;
}

/** Measures the opaque content rectangle and the card's outer rectangle in one decoded frame. */
export function measureViewFrameGeometry(frame, {
  contentColor,
  cardColor,
  planeColor,
  borderColors,
  targetRect,
  colorTolerance = DEFAULT_TOLERANCE,
} = {}) {
  if (!frame || !Number.isSafeInteger(frame.width) || frame.width < 1 ||
      !Number.isSafeInteger(frame.height) || frame.height < 1 ||
      !Number.isSafeInteger(frame.stride) || frame.stride < frame.width * 4 ||
      !frame.data || frame.data.length < frame.stride * frame.height) {
    throw new Error("recorded frame has invalid dimensions, stride, or pixel storage");
  }
  if (!Number.isFinite(frame.scale) || frame.scale <= 0 ||
      !Number.isFinite(frame.contentScale) || frame.contentScale <= 0 ||
      !frame.content || !Number.isFinite(frame.content.x) || !Number.isFinite(frame.content.y)) {
    throw new Error("recorded frame scale or content origin is invalid");
  }
  if (!Number.isFinite(frame.time) || frame.time < 0) throw new Error("recorded frame time is invalid");
  if (!Number.isInteger(colorTolerance) || colorTolerance < 0 || colorTolerance > 255) {
    throw new Error("color tolerance must be an integer from 0 through 255");
  }
  requireColor(contentColor, "contentColor");
  requireColor(cardColor, "cardColor");
  requireColor(planeColor, "planeColor");
  if (!Array.isArray(borderColors) || borderColors.length === 0) {
    throw new Error("borderColors must contain at least one RGB byte triplet");
  }
  borderColors.forEach((color, index) => requireColor(color, `borderColors[${index}]`));
  const options = { planeColor, cardColor, borderColors, tolerance: colorTolerance };
  let anchor;
  let targetCardRectPx;
  if (targetRect !== undefined) {
    if (!targetRect || ![targetRect.x, targetRect.y, targetRect.width, targetRect.height].every(Number.isFinite)
        || targetRect.width <= 0 || targetRect.height <= 0) {
      throw new Error("targetRect must be a finite non-empty window-content rectangle");
    }
    const ratio = frame.scale * frame.contentScale;
    anchor = {
      x: Math.floor(frame.content.x * frame.scale + (targetRect.x + targetRect.width / 2) * ratio),
      y: Math.floor(frame.content.y * frame.scale + (targetRect.y + targetRect.height / 2) * ratio),
    };
    if (anchor.x < 0 || anchor.y < 0 || anchor.x >= frame.width || anchor.y >= frame.height) {
      throw new Error("targetRect center lies outside the recorded frame");
    }
    targetCardRectPx = cardRectangle(frame, { left: anchor.x, top: anchor.y, right: anchor.x + 1, bottom: anchor.y + 1 }, options);
  }
  const nativeRectPx = contentRectangle(frame, contentColor, colorTolerance, targetCardRectPx);
  const cardRectPx = targetCardRectPx ?? cardRectangle(frame, nativeRectPx, options);
  return {
    timeMs: frame.time,
    scale: frame.scale,
    contentScale: frame.contentScale,
    nativeRectPx,
    cardRectPx,
    nativeRectPt: rectPoint(nativeRectPx, frame),
    cardRectPt: rectPoint(cardRectPx, frame),
  };
}
