// 네이티브 표면을 흉내 내는 컴포지터.
//
// 실제 계약과 같은 개념만 쓴다. declared 와 applied 는 한 커밋의 한 레코드에
// 함께 담긴다 — 따로 읽으면 두 시점의 두 값을 빼는 것이라 차이가 무엇을
// 뜻하는지 알 수 없다.
//
// 판을 모른다. 카드가 무엇인지, 탭이 어떻게 움직이는지 알 필요가 없다: 표면이
// 설 자리와 그 자리가 무엇을 담았는지는 판이 자리 요소에 표시해 두고, 여기서는
// 그 표시를 읽어 재고 알린다.
import { plugin } from "./plugins/registry.js";

const plane = document.getElementById("plane");

/* 호스트가 네이티브로 그리는 종류들. 그 종류의 표면은 여기서 흉내 내지 않는다. */
const hostKinds = () => window.hostSurfaces?.kinds ?? [];

/* 커밋이 끝났음을 듣는 쪽. 검증이 여기 붙는다. */
let listener = null;

/** 커밋마다 부를 함수를 건다. */
export function onCommit(fn) {
  listener = fn;
}

/** 사람이 정하는 두 값 — 커밋을 늦추고, 앉히는 자리를 어긋나게 한다. */
export const knobs = { latency: 0, skew: 0 };

let seq = 0;
let applied = 0;
let latestRecord = null;
let timer = null;
const drawn = new Map();

/** 마지막 커밋. 아직 없으면 null. */
export const latest = () => latestRecord;

/** 판을 다시 세울 때 흉내 낸 표면을 모두 걷는다. */
export function reset() {
  for (const el of drawn.values()) el.remove();
  drawn.clear();
  latestRecord = null;
  seq = 0;
  applied = 0;
}

function surfaceEl(id) {
  let el = drawn.get(id);
  if (el) return el;
  el = document.createElement("div");
  el.className = "surface";
  el.dataset.nativeSurfaceId = id;
  plane.appendChild(el);
  drawn.set(id, el);
  return el;
}

/**
 * 선언 ∧ 모든 조상의 data-surface-visible ∧ capture-hidden 이 아님.
 *
 * 세 번째 항이 드래그 중의 표시를 정한다. DOM 은 네이티브 표면 위에 그릴 수
 * 없으므로, 표면 위에 무언가를 그리는 동안에는 capture-hidden 으로 표면을
 * 숨기고 DOM 이 스냅샷을 그린다. 계약이 정의한 절차다.
 */
function effectiveVisible(slot) {
  if (slot.dataset.nativeVisible !== "true") return false;
  if (slot.dataset.nativeCaptureHidden === "true") return false;
  for (let n = slot.parentElement; n && n !== document.body; n = n.parentElement) {
    if (n.dataset?.surfaceVisible === "false") return false;
  }
  return true;
}

/** 표면이 설 자리들. 판이 표시해 둔 것을 그대로 읽는다. */
const slots = () =>
  plane.querySelectorAll("[data-native-surface][data-native-surface-id]");

/** 지금 자리들을 재어 커밋한다. 지연이 걸려 있으면 그만큼 늦춰 앉힌다. */
export function observe() {
  const mine = ++seq;
  const host = plane.getBoundingClientRect();
  const snapshot = [];
  for (const slot of slots()) {
    const r = slot.getBoundingClientRect();
    snapshot.push({
      id: slot.dataset.nativeSurfaceId,
      layer: Number(slot.dataset.nativeLayer),
      title: slot.dataset.nativeTitle,
      plugin: slot.dataset.nativePlugin,
      dim: slot.dataset.nativeDim === "true",
      visible: effectiveVisible(slot),
      frame: { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height },
    });
  }
  clearTimeout(timer);
  const deliver = () => commit(mine, snapshot);
  if (knobs.latency === 0) deliver();
  else timer = setTimeout(deliver, knobs.latency);
}

/** 유일한 네이티브 writer. 시퀀스가 뒤진 스냅샷은 여기서 거부된다. */
function commit(mine, snapshot) {
  if (mine < applied) return;
  applied = mine;
  const record = { seq: mine, surfaces: [] };
  const native = hostKinds();
  for (const s of snapshot) {
    const seat = { ...s.frame, x: s.frame.x + knobs.skew, y: s.frame.y + knobs.skew };
    const declared = {
      id: s.id, plugin: s.plugin, layer: s.layer, declared: s.frame, applied: seat,
      visible: s.visible, dim: s.dim,
      // 표면이 보여주는 것은 플러그인이 정한다. 호스트가 종류의 이름으로
      // 분기하면 플러그인을 하나 더 만들 때 호스트도 고쳐야 한다.
      surface: plugin(s.plugin).surface(s.id),
    };
    // 호스트가 네이티브로 그리는 표면에는 흉내 낸 요소를 두지 않는다. 둘 다
    // 두면 DOM 사본이 진짜 뷰 아래에 깔린다.
    if (native.includes(s.plugin)) {
      drawn.get(s.id)?.remove();
      drawn.delete(s.id);
      record.surfaces.push(declared);
      continue;
    }
    const el = surfaceEl(s.id);
    el.style.left = `${seat.x}px`; el.style.top = `${seat.y}px`;
    el.style.width = `${seat.w}px`; el.style.height = `${seat.h}px`;
    el.style.zIndex = String(50 + s.layer);
    el.dataset.hidden = String(!s.visible);
    // 라벨은 바뀔 때만 다시 쓴다. 커밋은 프레임마다 오는데 제목과 레이어는
    // 거의 그대로여서, 매번 다시 쓰면 표면 안이 프레임마다 새로 태어난다.
    const label = `<b>${s.title}</b><br>네이티브 표면 · ${s.plugin} · layer ${s.layer}`;
    if (el.dataset.label !== label) { el.innerHTML = label; el.dataset.label = label; }
    record.surfaces.push(declared);
  }
  for (const [id, el] of drawn) {
    if (!record.surfaces.some((x) => x.id === id)) { el.remove(); drawn.delete(id); }
  }
  for (const s of record.surfaces) {
    const slot = plane.querySelector(`[data-native-surface-id="${s.id}"][data-native-surface]`);
    if (slot) slot.dataset.nativeDeclaredFrame =
      `${s.declared.x.toFixed(2)},${s.declared.y.toFixed(2)},${s.declared.w.toFixed(2)},${s.declared.h.toFixed(2)}`;
  }
  latestRecord = record;
  window.hostSurfaces?.place?.(record);
  listener?.();
}

/**
 * 표면을 숨기고 같은 위치에 `.standin` 을 표시한다.
 *
 * 네이티브 표면은 OS 뷰라서 DOM 이 그 위에 그릴 수 없다. DOM 을 표면 위에
 * 그리는 동안 capture-hidden 으로 표면을 숨기고 `.standin` 을 대신 표시한다.
 * 표면 갱신은 그동안 중단되며 종료 시 복원된다.
 *
 * `.standin` 은 표면과 동일하게 표시한다. 표면을 숨기는 동안 화면이 변하면 안 된다.
 *
 * `over` 를 지정하면 그 영역과 겹치는 표면만 숨긴다. 드롭 구획은 판 전체를
 * 대상으로 하므로 전체를 숨기지만, 선택 레이어는 작아서 전체를 숨기면 겹치지
 * 않는 표면의 갱신까지 중단된다.
 */
export function standIn(on, over) {
  const host = over ? plane.getBoundingClientRect() : null;
  const native = hostKinds();
  for (const slot of slots()) {
    // 호스트가 네이티브로 그리는 표면은 살아 있는 내용을 보여준다: 도는 페이지,
    // 도는 프로그램. 그 위에 DOM 을 그리자고 숨기면 사람이 보고 있던 것이 정지
    // 화면으로 바뀐다. 그래서 숨기지 않고, DOM 은 컴포지터가 주는 순서를 받는다.
    if (native.includes(slot.dataset.nativePlugin)) {
      delete slot.dataset.nativeCaptureHidden;
      slot.innerHTML = "";
      continue;
    }
    let hide = on;
    if (hide && over) {
      const r = slot.getBoundingClientRect();
      hide = over.x < r.right - host.left && over.x + over.w > r.left - host.left
          && over.y < r.bottom - host.top && over.y + over.h > r.top - host.top;
    }
    if (hide) slot.dataset.nativeCaptureHidden = "true";
    else delete slot.dataset.nativeCaptureHidden;
    slot.innerHTML = "";
    if (!hide) continue;

    // 표면이 마지막으로 표시한 내용을 복제한다. 모델에서 다시 생성하면 숨기는
    // 시점의 표면이 아니라 현재 모델을 표시한다. 커밋 지연 중에는 둘이 다르다.
    const id = slot.dataset.nativeSurfaceId;
    const shown = drawn.get(id);
    if (!shown) continue;
    const el = document.createElement("div");
    el.className = "standin";
    el.innerHTML = shown.innerHTML;
    // 표면이 있던 위치에 배치한다. 선언 위치에 두면 적용 오차만큼 화면이 이동한다.
    const rec = latestRecord?.surfaces.find((x) => x.id === id);
    if (rec) el.style.transform =
      `translate(${rec.applied.x - rec.declared.x}px,${rec.applied.y - rec.declared.y}px)`;
    slot.appendChild(el);
  }
  observe();
}
