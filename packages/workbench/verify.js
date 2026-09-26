// 판과 컴포지터를 읽어 검증한다.
//
// 읽기만 하고 아무것도 변경하지 않는다. 판과 컴포지터는 검증의 존재를 알지 않으므로
// 검사를 추가해도 그쪽을 수정할 필요가 없다.
//
// 화면을 보고 판단하지 않고 수치로 판정한다.
import { Soksak } from "soksak";

import { ahead, latest, placementPending, seated } from "./compositor.js";
import { currentGrid, dropBands, plane, railOutline, tabsOf } from "./plane.js";
import { isPlace, railKind } from "./registry.js";
import { cardRadius } from "./settings.js";

/** 두 사각형의 최대 차이를 반환한다. 하나라도 없으면 비교하지 않는다. */
/** a 가 b 밖으로 나간 가장 먼 거리. 안에 있으면 0 이다. */
const beyond = (a, b) => a.w <= 0 || a.h <= 0 ? 0 :
  Math.max(0, b.x - a.x, b.y - a.y, a.x + a.w - (b.x + b.w), a.y + a.h - (b.y + b.h));

const maxDelta = (a, b) =>
  !a || !b ? Infinity
    : Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));

/**
 * 검증을 한 번 실행하고 결과를 반환한다.
 *
 * 화면에 그리지 않는다. 개발자가 읽는 값이고 렌더마다 발생하므로 출력 위치는
 * 호출자가 정한다.
 *
 * controls 는 창이 그리는 단추가 차지하는 영역이다. 창이 없는 브라우저에서는 null
 * 이고, 그 검사는 실행되지 않는다.
 */
export function verify(controls = null) {
  // 현재 판. 검증 한 번은 한 시점을 대상으로 하므로 처음에 한 번만 읽는다.
  const grid = currentGrid();
  const rows = [];
  const add = (n, ok, note) => rows.push([n, note, ok]);
  const cards = [...grid.cards];
  const box = grid.rects();                 // 한 번 재고 id 로 찾는다
  const rects = cards.map((c) => box.get(c.id));
  const { shape, rects: railRects } = railOutline();

  // 외곽선은 두 사각형을 통로의 절반만큼 키워 합치므로, 통로 하나를 사이에 둔 둘은
  // 통로 가운데에서 만나 한 루프가 된다. 붙었는지를 같은 기준으로 판정한다. 판이
  // 작아 한쪽이 크기 없이 그려지면 두 사각형이 맞닿기만 하는데, 키우면 그때도
  // 만나므로 겹침을 요구하면 붙은 것을 떨어졌다고 읽는다.
  const adjacent = railRects.length === 2 && (() => {
    const [a, b] = railRects;
    const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
    const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    return dx <= grid.gap + .5 && dy <= grid.gap + .5;
  })();
  // 외곽선은 카드와 동심이므로 카드가 각지면 외곽선도 각지다. 꼭짓점은 전부 라운드
  // 이거나 전부 각지고, 섞이면 한 모서리만 다른 모양이라는 뜻이다.
  const square = cardRadius() === 0;
  add("V0 레일 외곽선",
      shape.sharp === (square ? shape.corners : 0) &&
      shape.loops.length === (adjacent ? 1 : railRects.length),
      `${shape.loops.length}개 루프 · ${shape.corners}꼭짓점 중 ${shape.sharp} 각짐 · ` +
      `카드 ${square ? "각짐" : "라운드"} · ${adjacent ? "인접" : "떨어짐"}`);

  // V1 — 같은 선을 읽는 카드의 경계가 정확히 같다 (허용오차 없음)
  let drift = 0;
  for (const axis of ["x", "y"]) {
    const [lo, hi] = axis === "x" ? ["c0", "c1"] : ["r0", "r1"];
    for (let k = 1; k < grid.lines(axis).length - 1; k++) {
      const ends = cards.filter((c) => c[hi] === k).map((c) => {
        const r = box.get(c.id); return axis === "x" ? r.x + r.w : r.y + r.h;
      });
      const starts = cards.filter((c) => c[lo] === k).map((c) => {
        const r = box.get(c.id); return axis === "x" ? r.x : r.y;
      });
      for (const arr of [ends, starts]) if (arr.length > 1) drift = Math.max(drift, Math.max(...arr) - Math.min(...arr));
    }
  }
  // 카드의 먼 변은 `x + w` 로 되돌린 값이고, w 는 두 선의 차다. 같은 선에서 끝나는
  // 두 카드는 시작이 다르므로 그 덧셈의 마지막 비트가 다를 수 있다. 그것은 경계가
  // 둘이라는 뜻이 아니라 double 의 자리수이므로, 배치가 어긋난 것과 구별되는 만큼만
  // 허용한다 — 실제로 어긋나면 픽셀 단위로 벌어진다.
  const ULP = 1e-9;
  add("V1 공유 경계 편차 == 0", drift <= ULP,
      `최대 ${drift.toExponential(1)}px · 허용 ${ULP.toExponential(0)}px`);

  // 슬롯 상자의 합. `(w+gap)(h+gap)` 은 모든 선이 통로 하나를 차지한다는 가정이며,
  // 폭이 음수인 카드도 상쇄되어 통과했다.
  const X = (k) => grid.boundaryPos("x", k), Y = (k) => grid.boundaryPos("y", k);
  const area = grid.cards.reduce((n, c) => n + (X(c.c1) - X(c.c0)) * (Y(c.r1) - Y(c.r0)), 0);
  const want = grid.width * grid.height;
  // 판이 담을 수 있는 것보다 많이 담으면 자리를 잃은 카드가 크기 없이 그려진다(R5).
  // 그것은 라이브러리가 하는 일이므로 통과다. 변이 음수인 카드만 규칙 위반이고,
  // 그런 카드는 넓이 합에서 서로 상쇄되어 위의 Δ 로는 드러나지 않으므로 여기서 센다.
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
  // 통로가 정확히 gap 인 것은 판에 자리가 있는 동안이다. 판이 담는 것보다 많이
  // 담으면 자리를 잃은 카드가 변 없이 그려지고, 통로 합이 판을 넘으면 통로 자체가
  // 판에 맞춰 줄어든다(R5). 그 상태에서 gap 을 요구하면 라이브러리가 하지 않는
  // 약속을 검사하게 되므로, 통로가 gap 보다 넓지 않은 것만 본다.
  const squeezed = rects.some((r) => r.w <= 0 || r.h <= 0);
  add(`V3 겹침 0 · 통로 ${grid.gap}px`,
      overlap === 0 && (!isFinite(worst)
        || (squeezed ? worst <= grid.gap + 0.5 : Math.abs(worst - grid.gap) < 0.5)),
      overlap ? `겹침 ${overlap}쌍`
        : `최소 ${isFinite(worst) ? worst.toFixed(1) : grid.gap}px${squeezed ? " · 판이 좁아 통로가 줄었다" : ""}`);

  // V4 — 지금 상태를 담았다 되돌리면 그대로여야 한다. 스페이스 전환이 이 길을
  // 지난다 — capture 가 toJSON 으로 담고 adopt 가 replace 로 되돌린다. 여기서
  // 어긋나면 스페이스를 오간 것만으로 배치가 달라진다.
  //
  // 담은 것을 다시 판으로 만들어 지금 판이 그린 것과 비교한다. 살아 있는 판을
  // 건드리지 않으므로 사람이 보는 배치는 바뀌지 않는다.
  //
  // 통로와 크기를 왕복시키는 검사는 여기 있지 않다. resize 와 gap 은 선도 카드도
  // 건드리지 않고 rects 는 순수 함수이므로, 올바른 라이브러리에서 그 왕복은 상태와
  // 무관하게 언제나 0 이다. 그 약속은 test/resizeTrip.test.mjs 가 잰다.
  const trip = new Soksak(grid.toJSON(),
    { gap: grid.gap, minSize: grid.minSize, width: grid.width, height: grid.height });
  let rebuilt = 0;
  for (const [id, was] of trip.rects()) rebuilt = Math.max(rebuilt, maxDelta(was, box.get(id)));
  const smallest = Math.min(...rects.flatMap((r) => [r.w, r.h]));
  add("V4 담았다 되돌리면 그대로", rebuilt === 0,
      `사본 ${rebuilt.toFixed(4)}px · 그려진 최소 변 ${smallest.toFixed(0)}px`);

  add("V5 배치가 slicing", grid.isSlicing(), "한 영역을 통째로 자른 결과만 가능");

  const open = cards.filter((c) => !c.fixed);
  add("V6 마지막 하나 빼고 전부 닫힌다", open.length <= 1 || open.every((c) => grid.canClose(c.id)),
      `${open.filter((c) => grid.canClose(c.id)).length}/${open.length}`);

  // V7a — 마지막 커밋이 지금 그려진 표면을 그대로, 그려진 자리에 담고 있는가.
  //
  // 커밋에만 있는 표면과 판에만 있는 표면을 함께 센다. 하나도 겹치지 않는 커밋은
  // 겹치는 것이 없어서 통과하는 것이지 맞는 것이 아니다.
  const host = plane.getBoundingClientRect();
  const drawnFrame = (slot) => {
    const r = slot.getBoundingClientRect();
    return { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height };
  };
  const onPlane = new Map(
    [...plane.querySelectorAll("[data-native-surface][data-native-surface-id]")]
      .map((slot) => [slot.dataset.nativeSurfaceId, slot]),
  );
  // 커밋은 자리만이 아니라 표면의 상태도 담는다. 흐림은 판이 정하고 슬롯에 기록하는
  // 값이므로, 그려진 슬롯과 다르면 호스트가 다른 알파를 적용한다.
  const compare = (surfaces) => {
    const told = new Set(surfaces.map((s) => s.id));
    let worst = 0;
    let dim = 0;
    for (const s of surfaces) {
      const slot = onPlane.get(s.id);
      if (!slot) continue;
      worst = Math.max(worst, maxDelta(drawnFrame(slot), s.declared));
      if (s.dim !== (slot.dataset.nativeDim === "true")) dim++;
    }
    return {
      worst,
      dim,
      gone: surfaces.filter((s) => !onPlane.has(s.id)).length,
      missed: [...onPlane.keys()].filter((id) => !told.has(id)).length,
    };
  };

  const record = latest();
  const pendingPlacement = placementPending();
  if (!record) add("V7a element − declared == 0", true, "아직 커밋 없음");
  else if (pendingPlacement) add("V7a element − declared == 0", true, "host placement pending");
  else {
    const { worst, dim, gone, missed } = compare(record.surfaces);
    add("V7a element − declared == 0", gone === 0 && missed === 0 && worst < 0.5 && dim === 0,
        `최대 ${worst.toFixed(2)}px · 커밋에 없는 표면 ${missed} · 사라진 표면 ${gone} · ` +
        `흐림이 다른 표면 ${dim} · 0이 아니면 커밋이 뒤처진 것 (seq ${record.seq}, ` +
        // 기본값: 아직 앉힌 배치가 없으면 none 으로 적는다.
        `seated ${seated()?.seq ?? "none"}, pending ${pendingPlacement})`);
  }

  // V7c — 그리기 전에 미리 게시한 자리가 그려진 자리와 같은가. 여백은 그려질
  // 사각형에 대해 재므로 오차가 남을 자리가 없다.
  const guess = ahead();
  if (!guess) add("V7c 미리 게시한 자리 == 그려진 자리", true, "이번 렌더는 미리 게시하지 않았다");
  else if (pendingPlacement) add("V7c 미리 게시한 자리 == 그려진 자리", true, "host placement pending");
  else {
    const { worst, dim, gone, missed } = compare(guess.surfaces);
    add("V7c 미리 게시한 자리 == 그려진 자리",
        gone === 0 && missed === 0 && worst === 0 && dim === 0,
        `최대 ${worst.toFixed(2)}px · 없음 ${gone} · 누락 ${missed} · 흐림이 다른 표면 ${dim} ` +
        `(seq ${guess.seq})`);
  }

  // V7b — 동일한 요청의 선언 좌표와 호스트가 적용한 좌표를 비교한다.
  // 화면의 프레임 간 정렬은 outside.test.mjs가 별도로 검사한다.
  const placed = seated();
  let land = 0, landed = 0, escaped = 0;
  // 기본값: 아직 앉힌 배치가 없으면 잴 표면이 없다.
  for (const s of placed?.surfaces ?? []) {
    if (!s.visible || s.declared.w < 1 || s.declared.h < 1) continue;
    land = Math.max(land, maxDelta(s.declared, s.applied));
    escaped = Math.max(escaped, beyond(s.applied, s.declared));
    landed++;
  }
  add("V7b applied == declared",
      landed === 0 || (escaped === 0 && land === 0),
      landed
        ? `밖으로 ${escaped.toFixed(2)}px · 차이 ${land.toFixed(2)}px · ` +
          `${placed.settled ? "정지" : "갱신 중"} (seq ${placed.seq})`
        : "아직 답 없음");

  const transformed = [...plane.querySelectorAll(".card")]
    .filter((el) => el.style.transform && el.style.transform !== "none").length;
  add("V8 뷰가 transform 을 안 쓴다", transformed === 0, `${transformed}개 카드에 transform`);

  // V9 — 외곽선의 획이 카드 안쪽을 지나면 애플리케이션에서 네이티브 표면에 가려진다.
  const origin = plane.getBoundingClientRect();
  const renderedCards = [...plane.querySelectorAll(".card")].map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  });
  let onCard = 0;
  for (const loop of shape.loops) for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6));
    for (let t = 0; t <= steps; t++) {
      const x = a.x + (b.x - a.x) * (t / steps), y = a.y + (b.y - a.y) * (t / steps);
      if (renderedCards.some((r) => x > r.x + 2 && x < r.x + r.w - 2 && y > r.y + 2 && y < r.y + r.h - 2)) onCard++;
    }
  }
  add("V9 레일 획이 카드 안을 안 지난다", onCard === 0, `표본 ${onCard}점 침범`);

  // V10 — 네이티브 표면은 DOM overflow 로 잘리지 않는다. 선언 rect 가 클립 영역보다
  // 크면 표면이 카드 밖에 그려진다.
  let escape = 0;
  // 기본값: 아직 커밋이 없으면 잴 표면이 없다.
  for (const s of latest()?.surfaces ?? []) {
    // 표면의 id 는 탭이므로 카드는 그 슬롯에서 거슬러 찾는다.
    const el = plane
      .querySelector(`[data-native-surface-id="${s.id}"][data-native-surface]`)
      ?.closest("[data-card-id]");
    if (!el) continue;
    const c = el.getBoundingClientRect();
    const box = { x: c.left - host.left, y: c.top - host.top, w: c.width, h: c.height };
    escape = Math.max(escape, box.x - s.applied.x, (s.applied.x + s.applied.w) - (box.x + box.w),
                              box.y - s.applied.y, (s.applied.y + s.applied.h) - (box.y + box.h));
  }
  add("V10 표면이 카드를 안 뚫는다", pendingPlacement || escape <= 0,
      pendingPlacement ? "host placement pending" : `최대 ${Math.max(0, escape).toFixed(2)}px`);

  // R — 선은 판의 끝에서 그 바깥의 테두리까지 이어진다. 그 거리는 stage 의 안쪽
  // 여백이고 뷰의 bleed 가 그 값이다. 더 나가면 선이 판 밖, 테두리 위에 그려진다.
  // 여백은 재서 얻는다 — 이음새에서 스타일시트가 여백을 0 으로 만드므로 통로의
  // 절반과 다르다.
  //
  // 판이 뷰가 배치한 크기 그대로일 때만 잰다. 호스트가 판의 크기를 바꾸고 아직 다시
  // 그리지 않았으면 선은 이전 크기의 것이고, 그 차이는 선이 나간 거리가 아니다.
  const stage = plane.parentElement;
  const frame = stage.getBoundingClientRect();
  const pad = Math.max(0,
    host.left - (frame.left + parseFloat(getComputedStyle(stage).borderLeftWidth)));
  const laid = Math.abs(host.width - grid.width) < 0.5
    && Math.abs(host.height - grid.height) < 0.5;
  let past = 0;
  for (const rule of plane.querySelectorAll(".sp-rule")) {
    const r = rule.getBoundingClientRect();
    // 그리지 않는 선은 크기도 좌표도 0 이다. 판과 비교하면 판 전체만큼 나간 것이 된다.
    if (r.width === 0 && r.height === 0) continue;
    past = Math.max(past, host.left - r.left, r.right - host.right,
                          host.top - r.top, r.bottom - host.bottom);
  }
  add("R 선은 판 밖으로 여백까지만 나간다", pendingPlacement || !laid || past <= pad + 0.01,
      pendingPlacement ? "host placement pending" : laid ? `최대 ${past.toFixed(2)}px · 여백 ${pad.toFixed(2)}px`
           : "판이 아직 새 크기로 그려지지 않았다");

  // D — 드롭 구획의 머리와 발은 그려진 머리와 발이 끝나는 자리에서 끝나야 한다.
  // 판은 카드의 rect 를 기준으로 구획을 넘기고 그 rect 는 보더를 포함하는데, 머리와
  // 발은 보더 안쪽의 행이다. 어긋나면 그려진 머리 위의 드롭이 카드에 탭을 더하지
  // 않고 카드를 쪼갠다.
  //
  // 판이 넘기는 값과 그려진 카드를 비교한다. 여백을 재는 R 과 같은 방법이다 —
  // 스타일시트가 정하는 거리는 적어 두지 않고 그려진 것에서 잰다.
  //
  // 카드가 두 행을 담지 못할 만큼 낮으면 행이 함께 줄어든다. 그때 그려진 머리는
  // 선언한 높이가 아니므로 잴 대상이 아니다. 행의 선언 높이는 판이 루트에 심는다.
  const band = dropBands();
  const row = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  const head0 = row("--head"), foot0 = row("--foot");
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
  add("D 드롭 구획이 그려진 머리·발에서 끝난다", bandOff < 0.01,
      banded
        ? `최대 ${bandOff.toFixed(2)}px · 카드 ${banded}장 · ` +
          `머리 ${band.headerPx.toFixed(1)}px · 발 ${band.footerPx.toFixed(1)}px`
        : "머리와 발을 온전히 담은 카드가 없다");

  // T5 — 빈 카드는 도달 가능한 상태가 아니다.
  const empty = cards.filter((c) => !isPlace(c.id) && tabsOf(c).length === 0);
  add("T5 빈 카드 0", empty.length === 0, `${cards.length - empty.length}/${cards.length} 카드가 내용을 가짐`);

  // 세 자리가 각자의 규칙대로 배치되었는지 검사한다. 선언값이 아니라 그려진 폭을
  // 측정한다. 선언값은 요청이고 검증 대상은 결과다.
  const left = grid.card("left"), right = grid.card("right");
  const rail = grid.cards.find((c) => railKind(c.id));
  const drawn = (c) => (c ? grid.rect(c.id).w : null);
  const asked = (c) => (c && c.width !== undefined ? c.width : null);
  // 선언한 px 는 요청이다. 판에 자리가 있으면 그대로 그려지고, 없으면 나머지가 남은
  // 것을 나눠 가지므로 그보다 좁게 그려진다. 넓게 그려지는 것만 규칙 위반이다.
  const kept = (c) => c === undefined || asked(c) === null
    || drawn(c) <= asked(c) + 0.5;
  const say = (c, where) => {
    if (!c) return "없음";
    const w = drawn(c).toFixed(0);
    const a = asked(c);
    return a !== null && Math.abs(drawn(c) - a) >= 0.5
      ? `${w}px ${where} (${a.toFixed(0)} 요청)`
      : `${w}px ${where}`;
  };
  // 표시하지 않는 자리는 검사 대상이 아니다.
  const placeOk = (!left || left.c0 === 0)
    && (!right || right.c1 === grid.lines("x").length - 1)
    && [left, right, rail].every(kept);
  add("P 자리는 카드다", placeOk,
      `좌 ${say(left, "첫 열")} · ` +
      `레일 ${rail ? say(rail, "열 " + rail.c0) : "없음"} · ` +
      `우 ${say(right, "마지막 열")}`);

  // W — 창이 그리는 단추는 첫 행의 상하 가운데에 위치한다. 단추는 OS 가 그리고
  // 페이지는 그 영역을 읽을 수 없으므로, 호스트가 반환한 영역을 첫 행과 비교한다.
  // 전체 화면에서는 창이 단추를 첫 행 밖으로 옮긴다. 그때는 비교할 것이 없다.
  const bar = document.querySelector(".chrome-bar").getBoundingClientRect();
  if (controls && controls.y + controls.h <= bar.bottom) {
    const above = controls.y - bar.top;
    const below = bar.bottom - (controls.y + controls.h);
    add("W 창 단추는 첫 행 가운데", Math.abs(above - below) <= 0.5,
        `행 ${bar.height.toFixed(1)}px · 단추 ${controls.h.toFixed(1)}px · ` +
        `위 ${above.toFixed(1)} 아래 ${below.toFixed(1)}`);
  }

  return rows.map(([name, note, ok]) => ({ name, note, ok }));
}
