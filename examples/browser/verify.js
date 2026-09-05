// 판과 컴포지터를 읽어 검사한다.
//
// 둘 다 읽기만 하고 아무것도 바꾸지 않는다. 그래서 판도 컴포지터도 검증이
// 있다는 것을 모르고, 검사를 하나 더 붙여도 저쪽은 고칠 것이 없다.
//
// 캡처는 판단에, 합격은 수치로 — 화면을 보고 판단하는 대신 재어서 답한다.
import { latest } from "./compositor.js";
import { currentGrid, currentView, drawRail, plane, tabsOf } from "./plane.js";
import { isPlace, railKind } from "./plugins/registry.js";

/** 두 사각형이 가장 크게 어긋난 값. 하나라도 없으면 비교할 수 없다. */
const maxDelta = (a, b) =>
  !a || !b ? Infinity
    : Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));

/**
 * 한 번 검사하고 결과를 돌려준다.
 *
 * 화면에 그리지 않는다. 이것은 개발자가 읽는 값이지 사람이 쓰는 화면이 아니고,
 * 매 렌더마다 나오므로 화면에 두면 그 자리를 계속 차지한다. 어디에 적을지는
 * 부르는 쪽이 정한다.
 */
export function verify() {
  // 지금의 판. 검사 한 번은 한 시점을 보는 것이므로 처음에 한 번만 집는다.
  const grid = currentGrid();
  const view = currentView();
  const rows = [];
  const add = (n, ok, note) => rows.push([n, note, ok]);
  const cards = [...grid.cards];
  const box = grid.rects();                 // 한 번 재고 id 로 찾는다
  const rects = cards.map((c) => box.get(c.id));
  const { shape, rects: railRects } = drawRail();

  const adjacent = railRects.length === 2 && (() => {
    const [a, b] = railRects;
    const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
    const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    return (Math.abs(dx - grid.gap) < .5 && dy < -.5) || (Math.abs(dy - grid.gap) < .5 && dx < -.5);
  })();
  add("V0 레일 외곽선", shape.sharp === 0 && shape.loops.length === (adjacent ? 1 : railRects.length),
      `${shape.loops.length}개 루프 · ${shape.corners}꼭짓점 전부 라운드 · ${adjacent ? "인접" : "떨어짐"}`);

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
  add("V1 공유 경계 편차 == 0", drift === 0, `최대 ${drift.toFixed(4)}px · 허용오차 없음`);

  // 슬롯 상자의 합. `(w+gap)(h+gap)` 은 모든 선이 복도 하나를 먹는다는 가정에서
  // 나온 지름길이고, 음수 폭 카드도 정확히 상쇄해 통과시켰다.
  const X = (k) => grid.boundaryPos("x", k), Y = (k) => grid.boundaryPos("y", k);
  const area = grid.cards.reduce((n, c) => n + (X(c.c1) - X(c.c0)) * (Y(c.r1) - Y(c.r0)), 0);
  const want = grid.width * grid.height;
  const noArea = rects.filter((r) => !(r.w > 0 && r.h > 0)).length;
  add("V2 판이 빈틈없이 덮임", Math.abs(area - want) < 2 && noArea === 0,
      `Δ ${(area - want).toFixed(1)}px²` + (noArea ? ` · 면적 없는 카드 ${noArea}장` : ""));

  let worst = Infinity, overlap = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
    const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    if (dx < -0.01 && dy < -0.01) { overlap++; continue; }
    worst = Math.min(worst, Math.max(dx, dy));
  }
  add(`V3 겹침 0 · 통로 ${grid.gap}px`,
      overlap === 0 && (!isFinite(worst) || Math.abs(worst - grid.gap) < 0.5),
      overlap ? `겹침 ${overlap}쌍` : `최소 ${isFinite(worst) ? worst.toFixed(1) : grid.gap}px`);

  const smallest = Math.min(...rects.flatMap((r) => [r.w, r.h]));
  add(`V4 카드 최소 변 ≥ ${grid.minSize}px`, smallest >= grid.minSize - 0.6, `최소 ${smallest.toFixed(0)}px`);
  add("V5 배치가 slicing", grid.isSlicing(), "한 영역을 통째로 자른 결과만 가능");

  const open = cards.filter((c) => !c.fixed);
  add("V6 마지막 하나 빼고 전부 닫힌다", open.length <= 1 || open.every((c) => grid.canClose(c.id)),
      `${open.filter((c) => grid.canClose(c.id)).length}/${open.length}`);

  // V7a / V7b — 합성. 두 차이는 원인이 다르므로 나눠서 재고,
  // declared 와 applied 는 같은 커밋의 한 레코드에서 읽는다.
  const host = plane.getBoundingClientRect();
  const record = latest();
  let stale = 0, land = 0, counted = 0;
  for (const s of record?.surfaces ?? []) {
    const slot = plane.querySelector(`[data-native-surface-id="${s.id}"][data-native-surface]`);
    if (!slot) continue;
    const r = slot.getBoundingClientRect();
    stale = Math.max(stale, maxDelta({ x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height }, s.declared));
    land = Math.max(land, maxDelta(s.declared, s.applied));
    counted++;
  }
  // 첫 렌더는 커밋보다 앞서므로 비교할 표면이 없다. 비교할 것이 없는 것은
  // 어긋난 것이 아니다 — 표면이 있어야 하는데 없는 경우는 V10 과 T5 가 본다.
  add("V7a element − declared == 0", counted === 0 || stale < 0.5,
      counted ? `최대 ${stale.toFixed(2)}px · 0이 아니면 커밋이 뒤처진 것 (seq ${record.seq})` : "아직 커밋 없음");
  add("V7b declared − applied == 0", counted === 0 || land < 0.5,
      counted ? `최대 ${land.toFixed(2)}px · 0이 아니면 컴포지터가 못 앉힌 것` : "아직 커밋 없음");

  const transformed = [...plane.querySelectorAll(".card")]
    .filter((el) => el.style.transform && el.style.transform !== "none").length;
  add("V8 뷰가 transform 을 안 쓴다", transformed === 0, `${transformed}개 카드에 transform`);

  // V9 — 그려지는 것은 외곽선이다. 그 획이 카드 안쪽을 지나면 실제 앱에서
  // 네이티브 표면에 가려 보이지 않는다.
  let onCard = 0;
  for (const loop of shape.loops) for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6));
    for (let t = 0; t <= steps; t++) {
      const x = a.x + (b.x - a.x) * (t / steps), y = a.y + (b.y - a.y) * (t / steps);
      if (rects.some((r) => x > r.x + 2 && x < r.x + r.w - 2 && y > r.y + 2 && y < r.y + r.h - 2)) onCard++;
    }
  }
  add("V9 레일 획이 카드 안을 안 지난다", onCard === 0, `표본 ${onCard}점 침범`);

  // V10 — 네이티브 표면은 DOM overflow 에 잘리지 않는다. 선언 rect 가 클립보다
  // 크면 표면이 카드 밖에 그려진다.
  let escape = 0;
  for (const s of latest()?.surfaces ?? []) {
    const el = plane.querySelector(`[data-card-id="${s.id}"]`);
    if (!el) continue;
    const c = el.getBoundingClientRect();
    const box = { x: c.left - host.left, y: c.top - host.top, w: c.width, h: c.height };
    escape = Math.max(escape, box.x - s.applied.x, (s.applied.x + s.applied.w) - (box.x + box.w),
                              box.y - s.applied.y, (s.applied.y + s.applied.h) - (box.y + box.h));
  }
  add("V10 표면이 카드를 안 뚫는다", escape <= 0.5, `최대 ${Math.max(0, escape).toFixed(2)}px`);

  // T5 — 빈 카드는 도달 가능한 상태가 아니다
  const empty = cards.filter((c) => !isPlace(c.id) && tabsOf(c).length === 0);
  add("T5 빈 카드 0", empty.length === 0, `${cards.length - empty.length}/${cards.length} 카드가 내용을 가짐`);

  // 세 자리가 각자의 규칙대로 서 있는가.
  //
  // 선언값이 아니라 그려진 폭을 잰다. 선언값은 요청이고 검증 대상은 결과다.
  const left = grid.card("left"), right = grid.card("right");
  const rail = grid.cards.find((c) => railKind(c.id));
  const drawn = (c) => (c ? grid.rect(c.id).w : null);
  const asked = (c) => (c && c.width !== undefined ? c.width : null);
  const kept = (c) => c === undefined || c === null || asked(c) === null
    || Math.abs(drawn(c) - asked(c)) < 0.5;
  const say = (c, where) => {
    if (!c) return "없음";
    const w = drawn(c).toFixed(0);
    const a = asked(c);
    return a !== null && Math.abs(drawn(c) - a) >= 0.5
      ? `${w}px ${where} (${a.toFixed(0)} 요청)`
      : `${w}px ${where}`;
  };
  // 없는 자리는 규칙을 어길 수 없다 — 좌측을 껐다고 FAIL 이 될 일이 아니다.
  const placeOk = (!left || left.c0 === 0)
    && (!right || right.c1 === grid.lines("x").length - 1)
    && [left, right, rail].every(kept);
  add("P 자리는 카드다", placeOk,
      `좌 ${say(left, "첫 열")} · ` +
      `레일 ${rail ? say(rail, "열 " + rail.c0) : "없음"} · ` +
      `우 ${say(right, "마지막 열")}`);

  return rows.map(([name, note, ok]) => ({ name, note, ok }));
}
