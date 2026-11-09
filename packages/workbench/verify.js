// Verifies by reading the plane and the compositor.
//
// It only reads and changes nothing. The plane and the compositor do not know that verification exists, so
// adding a check does not require editing them.
//
// It judges by numbers, not by looking at the screen.
import { Soksak } from "soksak";

import { ahead, latest, placementPending, seated } from "./compositor.js";
import { currentGrid, dropBands, plane, presentedCardRect, railOutline, tabsOf } from "./plane.js";
import { isPlace } from "./registry.js";
import { expectedRailLoops, windowSidebarsPlaced } from "./verify-checks.js";
import { cardRadius } from "./settings.js";
import { gridScale } from "./device-grid.js";

/** Returns the maximum difference of two rectangles. They are not compared when either one is missing. */
const maxDelta = (a, b) =>
  !a || !b ? Infinity
    : Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));

/**
 * The rectangle r fitted inward to the device pixels of scale, as both hosts fit a declared surface: the left and top edges
 * move to the next device pixel and the right and bottom edges to the previous one, and the size stays at least one
 * device pixel.
 */
const fitted = (r, scale) => {
  const step = 1 / scale;
  const left = Math.ceil(r.x * scale) / scale;
  const top = Math.ceil(r.y * scale) / scale;
  return { x: left, y: top, w: Math.max(Math.floor((r.x + r.w) * scale) / scale - left, step),
    h: Math.max(Math.floor((r.y + r.h) * scale) / scale - top, step) };
};

/**
 * The rectangle r as the page paints it on the device pixels of scale: the layout measures an edge in fractions of a point
 * finer than a device pixel and paints it at the nearest device pixel.
 */
const painted = (r, scale) => {
  const edge = (value) => Math.round(value * scale) / scale;
  const left = edge(r.x);
  const top = edge(r.y);
  return { x: left, y: top, w: edge(r.x + r.w) - left, h: edge(r.y + r.h) - top };
};

/**
 * The edges of r, a rectangle on the device pixels of scale, as whole device pixels. Two rectangles on one grid are compared by
 * these numbers and not by their points, which carry the remainders of the coordinates in which each side computed them: the
 * host fits in window coordinates and answers in plane coordinates, so an edge on a third of a point reads 413.0000000000001.
 */
const pixelEdges = (r, scale) => ({
  left: Math.round(r.x * scale), top: Math.round(r.y * scale),
  right: Math.round((r.x + r.w) * scale), bottom: Math.round((r.y + r.h) * scale),
});

/** The largest difference of the edges of two rectangles on the device pixels of scale, in points. */
const gridDelta = (a, b, scale) => {
  if (!a || !b) return Infinity;
  const p = pixelEdges(a, scale);
  const q = pixelEdges(b, scale);
  return Math.max(Math.abs(p.left - q.left), Math.abs(p.top - q.top), Math.abs(p.right - q.right), Math.abs(p.bottom - q.bottom)) / scale;
};

/** How far a goes beyond b, both on the device pixels of scale, in points. It is 0 when a is inside b. */
const gridBeyond = (a, b, scale) => {
  if (a.w <= 0 || a.h <= 0) return 0;
  const p = pixelEdges(a, scale);
  const q = pixelEdges(b, scale);
  return Math.max(0, q.left - p.left, q.top - p.top, p.right - q.right, p.bottom - q.bottom) / scale;
};

/**
 * Runs the verification once and returns the result.
 *
 * It does not draw on the screen. The value is read by a developer and arises on every render, so the caller
 * decides where to output it.
 *
 * controls is the area that the buttons drawn by the window occupy. In a browser without a window it is null,
 * and the check that uses it does not run.
 */
export function verify(controls = null) {
  // The current plane. One verification targets one point in time, so the plane is read once at the start.
  const grid = currentGrid();
  const rows = [];
  const add = (n, ok, note) => rows.push({ name: n, note, ok });
  // A check that has nothing to measure in this state is no pass. It is stated as skipped.
  const skip = (n, note) => rows.push({ name: n, note, skipped: true });
  const cards = [...grid.cards];
  const box = grid.rects();                 // Measures once and looks up by id
  const rects = cards.map((c) => box.get(c.id));
  const { shape, rects: railRects, groups } = railOutline();
  const expectedLoops = expectedRailLoops(groups, grid.gap);
  const square = cardRadius() === 0;
  if (groups.length === 0 && shape.loops.length === 0) skip("V0 레일 외곽선", "레일이 없다");
  else add("V0 레일 외곽선", shape.sharp === (square ? shape.corners : 0) && shape.loops.length === expectedLoops,
      `${shape.loops.length}/${expectedLoops}개 루프 · ${groups.length}개 연결 묶음 · ${railRects.length}개 사각형`);

  // V1 — cards that read the same line have exactly the same boundary (no tolerance)
  let drift = 0, shared = 0;
  for (const axis of ["x", "y"]) {
    const [lo, hi] = axis === "x" ? ["c0", "c1"] : ["r0", "r1"];
    for (let k = 1; k < grid.lines(axis).length - 1; k++) {
      const ends = cards.filter((c) => c[hi] === k).map((c) => {
        const r = box.get(c.id); return axis === "x" ? r.x + r.w : r.y + r.h;
      });
      const starts = cards.filter((c) => c[lo] === k).map((c) => {
        const r = box.get(c.id); return axis === "x" ? r.x : r.y;
      });
      for (const arr of [ends, starts]) {
        if (arr.length > 1) {
          drift = Math.max(drift, Math.max(...arr) - Math.min(...arr));
          shared++;
        }
      }
    }
  }
  // The far side of a card is the value restored as `x + w`, and w is the difference of two lines. Two cards that end
  // on the same line start differently, so the last bit of that addition can differ. That does not mean there are two
  // boundaries; it is the digits of a double, so the check allows only as much as distinguishes it from a misaligned
  // layout — a layout that is actually misaligned differs by pixels.
  const ULP = 1e-9;
  if (shared === 0) skip("V1 공유 경계 편차 == 0", "경계를 함께 쓰는 카드가 없다");
  else add("V1 공유 경계 편차 == 0", drift <= ULP,
      `최대 ${drift.toExponential(1)}px · 허용 ${ULP.toExponential(0)}px · 경계 ${shared}개`);

  // The sum of the slot boxes. `(w+gap)(h+gap)` assumes that every line occupies one gap, and
  // cards with a negative width cancelled each other and passed.
  const X = (k) => grid.boundaryPos("x", k), Y = (k) => grid.boundaryPos("y", k);
  const area = grid.cards.reduce((n, c) => n + (X(c.c1) - X(c.c0)) * (Y(c.r1) - Y(c.r0)), 0);
  const want = grid.width * grid.height;
  // When the plane holds more than it can contain, a card that lost its place is drawn without a size (R5).
  // That is what the library does, so it passes. Only a card with a negative side violates the rule, and
  // such cards cancel each other in the area sum and do not appear in the Δ above, so they are counted here.
  const inverted = rects.filter((r) => r.w < 0 || r.h < 0).length;
  add("V2 판이 빈틈없이 덮임", Math.abs(area - want) < 2 && inverted === 0,
      `Δ ${(area - want).toFixed(1)}px²` + (inverted ? ` · 뒤집힌 카드 ${inverted}장` : ""));

  let worst = Infinity, overlap = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
    const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    if (dx < -0.01 && dy < -0.01) { overlap++; continue; }
    worst = Math.min(worst, Math.max(dx, dy));
  }
  // The gap is exactly gap only while the plane has room. When the plane holds more than it can contain,
  // a card that lost its place is drawn without sides, and when the sum of the gaps exceeds the plane, the gaps
  // themselves shrink to fit the plane (R5). Requiring gap in that state would check a promise that the library
  // does not make, so the check only looks that the gap is not wider than gap.
  const squeezed = rects.some((r) => r.w <= 0 || r.h <= 0);
  if (overlap === 0 && !isFinite(worst)) skip(`V3 겹침 0 · 통로 ${grid.gap}px`, "카드가 하나뿐이다");
  else add(`V3 겹침 0 · 통로 ${grid.gap}px`,
      overlap === 0 && (squeezed ? worst <= grid.gap + 0.5 : Math.abs(worst - grid.gap) < 0.5),
      overlap ? `겹침 ${overlap}쌍` : `최소 ${worst.toFixed(1)}px${squeezed ? " · 판이 좁아 통로가 줄었다" : ""}`);

  // V4 — capturing the current state and restoring it must give the same state. A space switch goes through
  // this path — capture stores with toJSON and adopt restores with replace. If they differ here,
  // the layout changes just by moving between spaces.
  //
  // Rebuilds the captured state as a plane and compares it with what the current plane draws. It does not
  // touch the live plane, so the layout that a person sees does not change.
  //
  // A check that round-trips the gap and the size is not here. resize and gap touch neither lines nor cards, and rects is
  // a pure function, so in a correct library that round trip is always 0 regardless of the state. That promise is
  // measured by test/resizeTrip.test.mjs.
  const trip = new Soksak(grid.toJSON(),
    { gap: grid.gap, minSize: grid.minSize, width: grid.width, height: grid.height });
  let rebuilt = 0;
  for (const [id, was] of trip.rects()) rebuilt = Math.max(rebuilt, maxDelta(was, box.get(id)));
  const smallest = Math.min(...rects.flatMap((r) => [r.w, r.h]));
  add("V4 담았다 되돌리면 그대로", rebuilt === 0,
      `사본 ${rebuilt.toFixed(4)}px · 그려진 최소 변 ${smallest.toFixed(0)}px`);

  add("V5 배치가 slicing", grid.isSlicing(), "한 영역을 통째로 자른 결과만 가능");

  const open = cards.filter((c) => !c.fixed);
  if (open.length <= 1) skip("V6 마지막 하나 빼고 전부 닫힌다", "열린 카드가 하나뿐이다");
  else add("V6 마지막 하나 빼고 전부 닫힌다", open.every((c) => grid.canClose(c.id)),
      `${open.filter((c) => grid.canClose(c.id)).length}/${open.length}`);

  // V7a — does the last commit hold the surfaces that are drawn now, exactly, at the places where they are drawn (V7a in
  // docs/spec/surface-composition.md#failure-behavior). An invisible declaration with zero width or zero height has no presented area,
  // so it has no place to compare; it still counts for the slots and the dimming.
  //
  // It counts the surfaces that are only in the commit and the surfaces that are only in the plane together. A commit
  // that overlaps nothing passes because nothing overlaps, not because it is correct.
  const host = plane.getBoundingClientRect();
  const drawnFrame = (slot) => {
    const r = slot.getBoundingClientRect();
    return { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height };
  };
  const onPlane = new Map(
    [...plane.querySelectorAll("[data-native-surface][data-native-surface-id]")]
      .map((slot) => [slot.dataset.nativeSurfaceId, slot]),
  );
  // A commit holds not only the places but also the state of the surface. The blur is a value that the plane sets and records in the slot,
  // so if it differs from the drawn slot, the host applies a different alpha.
  const frameText = (r) => `${+r.x.toFixed(2)},${+r.y.toFixed(2)} ${+r.w.toFixed(2)}×${+r.h.toFixed(2)}`;
  // A section body is marked "view" by sidebar-sections.js. Its surface is measured after the drawing (docs/spec/native-surfaces.md#section-seats),
  // so a prediction never holds it.
  const predicted = (id) => onPlane.get(id).dataset.nativeSurface !== "view";
  // The ids of a list, so a failure names the surfaces that it counts.
  const named = (ids) => (ids.length ? ` [${ids.join(", ")}]` : "");
  // default: a comparison measures the difference of the drawn and the declared rectangle as they are.
  const compare = (surfaces, onlyPredicted = false, placed = () => true, apart = maxDelta) => {
    const told = new Set(surfaces.map((s) => s.id));
    let worst = 0;
    // The surface that is off the most and its two places. A failure states the measured values with which the cause can be found.
    let at = "";
    let dim = 0;
    for (const s of surfaces) {
      const slot = onPlane.get(s.id);
      if (!slot) continue;
      if (s.dim !== (slot.dataset.nativeDim === "true")) dim++;
      if (!placed(s)) continue;
      const drawn = drawnFrame(slot);
      const delta = apart(drawn, s.declared);
      if (delta > worst) {
        worst = delta;
        at = ` · ${s.id} drawn ${frameText(drawn)} declared ${frameText(s.declared)}`;
        // The band published in advance and the band of the drawn card. If they differ, the prediction was computed with a different sidebar state (F33).
        if (s.bands) {
          const card = slot.closest("[data-card-id]");
          // default: a card on a side without a sidebar has no band variable, and that side occupies no space (0).
          const shown = ["top", "bottom", "left", "right"].map((side) => card?.style.getPropertyValue(`--p${side[0]}`) || "0");
          at += ` · bands ${["top", "bottom", "left", "right"].map((side) => s.bands[side]).join("/")} drawn ${shown.join("/")}`;
        }
        // The drawn card and the place of the surface in it. It states whether the difference comes from the size of the card or from the layout inside the card (F90).
        const owner = slot.closest("[data-card-id]");
        if (owner) {
          const box = drawnFrame(owner);
          at += ` · card ${frameText(box)} inset ${+(drawn.x - box.x).toFixed(2)},${+(drawn.y - box.y).toFixed(2)},` +
            `${+(box.x + box.w - drawn.x - drawn.w).toFixed(2)},${+(box.y + box.h - drawn.y - drawn.h).toFixed(2)}` +
            ` · plane ${+host.left.toFixed(2)},${+host.top.toFixed(2)} ${+host.width.toFixed(2)}×${+host.height.toFixed(2)}` +
            ` · card style ${owner.style.width}×${owner.style.height} · devicePixelRatio ${devicePixelRatio}`;
        }
      }
    }
    const gone = surfaces.filter((s) => !onPlane.has(s.id)).map((s) => s.id);
    // default: without onlyPredicted every surface of the plane is checked.
    const missed = [...onPlane.keys()].filter((id) => !told.has(id) && (!onlyPredicted || predicted(id)));
    return { worst, at, dim, gone: gone.length, missed: missed.length, goneIds: named(gone), missedIds: named(missed) };
  };

  const record = latest();
  const pendingPlacement = placementPending();
  if (!record) skip("V7a element − declared == 0", "아직 커밋 없음");
  else if (pendingPlacement) skip("V7a element − declared == 0", "host placement pending");
  else if (record.surfaces.length === 0 && onPlane.size === 0) skip("V7a element − declared == 0", "커밋에도 판에도 표면이 없다");
  else {
    // A declaration has a place when it is visible or has an area (native-surfaces.md: a slot with zero width or zero height is
    // submitted as invisible and has no presented area).
    const hasPlace = (s) => s.visible !== false || (s.declared.w > 0 && s.declared.h > 0);
    const { worst, at, dim, gone, missed, goneIds, missedIds } = compare(record.surfaces, false, hasPlace);
    add("V7a element − declared == 0", gone === 0 && missed === 0 && worst < 0.5 && dim === 0,
        `최대 ${worst.toFixed(2)}px · 커밋에 없는 표면 ${missed}${missedIds} · 사라진 표면 ${gone}${goneIds} · ` +
        `흐림이 다른 표면 ${dim} · 0이 아니면 커밋이 뒤처진 것 (seq ${record.seq}, ` +
        // default: when no layout has been seated yet, it is written as none.
        `seated ${seated()?.seq ?? "none"}, pending ${pendingPlacement})${at}`);
  }

  // V7c — is the place published in advance before drawing the same as the drawn place. The margin is measured against the drawn
  // rectangle, so there is no place for an error to remain. The check runs only when the prediction holds exactly the card surfaces; a
  // section surface is measured by the commit that follows, which V7a checks.
  // The plane lies on the device pixel grid (device-grid.js), so the plane coordinates of both rectangles share its lines.
  // The host seats the predicted rectangle fitted inward to the device pixels, and the page paints the drawn slot at the
  // device pixels nearest to its edges, so V7c compares the two in device pixels of the one grid scale.
  const scale = gridScale();
  if (!(scale > 0)) throw new Error(`verify: the device pixel ratio ${scale} is not a positive number`);
  const guess = ahead();
  if (!guess) skip("V7c 미리 게시한 자리 == 그려진 자리", "이번 렌더는 미리 게시하지 않았다");
  else if (pendingPlacement) skip("V7c 미리 게시한 자리 == 그려진 자리", "host placement pending");
  else {
    const onScreen = (drawn, declared) => gridDelta(painted(drawn, scale), fitted(declared, scale), scale);
    const { worst, at, dim, gone, missed, goneIds, missedIds } = compare(guess.surfaces, true, undefined, onScreen);
    add("V7c 미리 게시한 자리 == 그려진 자리",
        gone === 0 && missed === 0 && worst === 0 && dim === 0,
        `최대 ${worst.toFixed(2)}px · 없음 ${gone}${goneIds} · 누락 ${missed}${missedIds} · 흐림이 다른 표면 ${dim} ` +
        `(seq ${guess.seq})${at}`);
  }

  // V7b — compares the declared coordinates of the same request with the coordinates that the host applied. The host fits
  // the declared rectangle inward to the device pixels of the backing scale of its window (docs/spec/native-surfaces.md), so
  // the applied rectangle is compared with the declared one fitted the same way: a display of one device pixel per point cannot
  // show half a point. The host answers that scale with each visible placement, and the window can change display between the
  // placement and this check, so each rectangle is judged on the grid of the scale that seated it, and a seat of a scale other
  // than the one of the display that shows the page is named: it is off the device pixels of that display until the next placement.
  // The alignment between frames on screen is checked separately by outside.test.mjs.
  const placed = seated();
  let land = 0, landed = 0, escaped = 0;
  // The surface that is off the most and its two places. A failure states the measured values with which the cause can be found (F36).
  let landedAt = "";
  const elsewhere = [];
  // default: when no layout has been seated yet, there is no surface to measure.
  for (const s of placed?.surfaces ?? []) {
    if (!s.visible || s.declared.w < 1 || s.declared.h < 1) continue;
    const seat = s.scale;
    if (!(seat > 0)) throw new Error(`verify: seated surface ${s.id} has no seat scale (${seat})`);
    // Both rectangles lie on the device pixels of the seat, so they are compared in whole device pixels; the fitted declared
    // rectangle is the largest one on that grid inside the declared one, so an applied edge outside it leaves the declared rectangle.
    const fit = fitted(s.declared, seat);
    const delta = gridDelta(fit, s.applied, seat);
    if (delta > land) landedAt = ` · ${s.id} declared ${frameText(s.declared)} applied ${frameText(s.applied)}`;
    land = Math.max(land, delta);
    escaped = Math.max(escaped, gridBeyond(s.applied, fit, seat));
    if (seat !== scale) elsewhere.push(`${s.id} seated at ${seat}`);
    landed++;
  }
  if (landed === 0) skip("V7b applied == declared", "아직 답 없음");
  else add("V7b applied == declared", escaped === 0 && land === 0 && elsewhere.length === 0,
      `밖으로 ${escaped.toFixed(2)}px · 차이 ${land.toFixed(2)}px · ` +
        `다른 scale 에 놓인 표면 ${elsewhere.length}${elsewhere.length ? ` (${elsewhere.join(", ")}, display ${scale})` : ""} · ` +
        `${placed.settled ? "정지" : "갱신 중"} (seq ${placed.seq})${landedAt}`);

  const transformed = [...plane.querySelectorAll(".card")]
    .filter((el) => el.style.transform && el.style.transform !== "none").length;
  add("V8 뷰가 transform 을 안 쓴다", transformed === 0, `${transformed}개 카드에 transform`);

  // V9 — if the stroke of the outline passes inside the card, the native surface covers it in the application.
  const origin = plane.getBoundingClientRect();
  const renderedCards = [...plane.querySelectorAll(".card")].map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  });
  let onCard = 0, samples = 0;
  for (const loop of shape.loops) for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6));
    for (let t = 0; t <= steps; t++) {
      samples++;
      const x = a.x + (b.x - a.x) * (t / steps), y = a.y + (b.y - a.y) * (t / steps);
      if (renderedCards.some((r) => x > r.x + 2 && x < r.x + r.w - 2 && y > r.y + 2 && y < r.y + r.h - 2)) onCard++;
    }
  }
  if (samples === 0) skip("V9 레일 획이 카드 안을 안 지난다", "레일 획이 없다");
  else add("V9 레일 획이 카드 안을 안 지난다", onCard === 0, `표본 ${samples}점 중 ${onCard}점 침범`);

  // V10 — a native surface is not clipped by DOM overflow. If the declared rect is larger than the clip area,
  // the surface is drawn outside the card.
  let escape = 0, standing = 0;
  // default: when there is no commit yet, there is no surface to measure.
  for (const s of latest()?.surfaces ?? []) {
    if (!s.visible) continue;
    // The id of a surface is a tab, so the card is found backwards from its slot.
    const el = plane
      .querySelector(`[data-native-surface-id="${s.id}"][data-native-surface]`)
      ?.closest("[data-card-id]");
    if (!el) continue;
    standing++;
    const c = el.getBoundingClientRect();
    const box = { x: c.left - host.left, y: c.top - host.top, w: c.width, h: c.height };
    escape = Math.max(escape, box.x - s.applied.x, (s.applied.x + s.applied.w) - (box.x + box.w),
                              box.y - s.applied.y, (s.applied.y + s.applied.h) - (box.y + box.h));
  }
  if (pendingPlacement) skip("V10 표면이 카드를 안 뚫는다", "host placement pending");
  else if (standing === 0) skip("V10 표면이 카드를 안 뚫는다", "카드 안에 보이는 표면이 없다");
  else add("V10 표면이 카드를 안 뚫는다", escape <= 0, `최대 ${Math.max(0, escape).toFixed(2)}px · 표면 ${standing}개`);

  // R — the line continues from the edge of the plane to the border outside it. That distance is the inner
  // margin of the stage, and the bleed of the view is that value. If it goes further, the line is drawn outside the plane, on the border.
  // The margin is obtained by measuring — at a seam the style sheet makes the margin 0, so it differs from half of the
  // gap.
  //
  // It measures only when the plane is at the size the view drew last. If the host changed the size of the plane and the view has not
  // drawn again, the lines are of the earlier size, and that difference is not the distance by which a line went out. The grid has the
  // new size before drawing (when a new layout replaces the awaited layout), so the check compares with the extent that the drawn cards cover (F34).
  const stage = plane.parentElement;
  const frame = stage.getBoundingClientRect();
  const pad = Math.max(0,
    host.left - (frame.left + parseFloat(getComputedStyle(stage).borderLeftWidth)));
  let paintedWidth = 0;
  let paintedHeight = 0;
  for (const card of cards) {
    const shown = presentedCardRect(card.id);
    if (!shown) continue;
    paintedWidth = Math.max(paintedWidth, shown.x + shown.w);
    paintedHeight = Math.max(paintedHeight, shown.y + shown.h);
  }
  const laid = Math.abs(host.width - paintedWidth) < 0.5
    && Math.abs(host.height - paintedHeight) < 0.5;
  let past = 0, lines = 0;
  for (const rule of plane.querySelectorAll(".sp-rule")) {
    const r = rule.getBoundingClientRect();
    // A line that is not drawn has size 0 and coordinate 0. Comparing it with the plane would count it as going out by the whole plane.
    if (r.width === 0 && r.height === 0) continue;
    lines++;
    past = Math.max(past, host.left - r.left, r.right - host.right,
                          host.top - r.top, r.bottom - host.bottom);
  }
  if (pendingPlacement) skip("R 선은 판 밖으로 여백까지만 나간다", "host placement pending");
  else if (!laid) skip("R 선은 판 밖으로 여백까지만 나간다", "판이 아직 새 크기로 그려지지 않았다");
  else if (lines === 0) skip("R 선은 판 밖으로 여백까지만 나간다", "그려진 선이 없다");
  else add("R 선은 판 밖으로 여백까지만 나간다", past <= pad + 0.01, `최대 ${past.toFixed(2)}px · 여백 ${pad.toFixed(2)}px`);

  // D — the header and the footer of a drop zone must end where the drawn header and footer end.
  // The plane passes the zones based on the rect of the card, and that rect includes the border, but the header and
  // the footer are rows inside the border. If they differ, a drop on the drawn header splits the card
  // instead of adding a tab to it.
  //
  // Compares the values that the plane passes with the drawn card. This is the same method as R, which measures the margin —
  // a distance that the style sheet sets is not written down but measured from what is drawn.
  //
  // When a card is too low to hold two rows, the rows shrink together. The drawn header is then not the
  // declared height, so it is not a target to measure. The declared height of a row is a chrome metric that the page sets on the root.
  const band = dropBands();
  const row = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  const head0 = row("--head-h"), foot0 = row("--foot-h");
  let bandOff = 0, banded = 0;
  for (const el of plane.querySelectorAll(".card[data-card-id]")) {
    const box = el.getBoundingClientRect();
    const top = el.querySelector(".chrome").getBoundingClientRect();
    const bottom = el.querySelector(".status").getBoundingClientRect();
    if (top.height < head0 - 0.01 || bottom.height < foot0 - 0.01) continue;
    bandOff = Math.max(bandOff,
      Math.abs((top.bottom - box.top) - band.headerPx),
      Math.abs((box.bottom - bottom.top) - band.footerPx));
    banded++;
  }
  if (banded === 0) skip("D 드롭 구획이 그려진 머리·발에서 끝난다", "머리와 발을 온전히 담은 카드가 없다");
  else add("D 드롭 구획이 그려진 머리·발에서 끝난다", bandOff < 0.01,
      `최대 ${bandOff.toFixed(2)}px · 카드 ${banded}장 · ` +
        `머리 ${band.headerPx.toFixed(1)}px · 발 ${band.footerPx.toFixed(1)}px`);

  // T5 — an empty card is not a reachable state.
  const empty = cards.filter((c) => !isPlace(c.id) && tabsOf(c).length === 0);
  add("T5 빈 카드 0", empty.length === 0, `${cards.length - empty.length}/${cards.length} 카드가 내용을 가짐`);

  // Checks that every window sidebar is placed by its own rule. It measures the drawn width, not the declared value.
  // The declared value is a request, and the target of verification is the result.
  const places = grid.cards.filter(card => isPlace(card.id));
  if (places.length === 0) skip("P 자리는 카드다", "창 사이드바가 없다");
  else add("P 자리는 카드다", windowSidebarsPlaced(grid), `${places.length}개 창 사이드바 · 가장자리 연속 열 · 저장 폭 상한 · 전체 높이`);

  // W — the buttons that the window draws are located at the vertical center of the first row. The OS draws the buttons and
  // the page cannot read that area, so the check compares the area that the host returned with the first row.
  // In full screen the window moves the buttons out of the first row. Then there is nothing to compare.
  // AppKit aligns the buttons to device pixels, so when the remaining height is an odd number of pixels, the top and the bottom differ by one pixel.
  const bar = document.querySelector(".chrome-bar").getBoundingClientRect();
  if (!controls || controls.y + controls.h > bar.bottom) skip("W 창 단추는 첫 행 가운데", "창 단추가 첫 행에 없다");
  else {
    const above = controls.y - bar.top;
    const below = bar.bottom - (controls.y + controls.h);
    const pixel = 1 / devicePixelRatio;
    add("W 창 단추는 첫 행 가운데", Math.abs(above - below) <= pixel,
        `행 ${bar.height.toFixed(1)}px · 단추 ${controls.h.toFixed(1)}px · ` +
        `위 ${above.toFixed(1)} 아래 ${below.toFixed(1)} · device pixel ${pixel.toFixed(2)}px`);
  }

  return rows;
}
