// 네이티브 표면을 모사하는 컴포지터.
//
// declared 와 applied 를 한 커밋의 한 레코드에 함께 담는다. 따로 읽으면 서로 다른
// 시점의 두 값을 빼게 되어 차이를 해석할 수 없다.
//
// 판의 구조를 알지 않는다. 표면의 위치와 내용은 판이 슬롯 요소의 data 속성에
// 기록하고, 이 모듈은 그 속성을 읽어 측정하고 보고한다.
import { plugin } from "./plugins/registry.js";
import { native, surfaces as app } from "./host.js";

const plane = document.getElementById("plane");

/* 커밋 완료 수신자. 검증이 여기에 연결된다. */
let listener = null;

/** 커밋마다 호출할 함수를 등록한다. */
export function onCommit(fn) {
  listener = fn;
}

/** 사용자가 설정하는 두 값. 커밋을 지연시키고 적용 위치에 오차를 만든다. */
export const knobs = { latency: 0, skew: 0 };

let seq = 0;
let applied = 0;
let latestRecord = null;
let timer = null;
const drawn = new Map();

/* 카드 안에서 슬롯이 차지하는 여백과 그 카드의 id. 여백은 카드의 헤더, 푸터,
   안쪽 패딩이므로 경계를 끄는 동안 변하지 않는다. DOM 을 측정하는 커밋에서 기록하고
   측정하지 않는 커밋에서 사용한다. 표면 id 는 탭 id 이므로 사각형 조회에 쓸 수 없다. */
const insets = new Map();

/** 슬롯이 속한 카드의 id. 판이 카드 요소에 기록한 값을 읽는다. */
const cardOf = (slot) => slot.closest("[data-card-id]")?.dataset.cardId;

/** 마지막 커밋 레코드를 반환한다. 없으면 null. */
export const latest = () => latestRecord;

/* 호스트가 실제 위치까지 답한 마지막 레코드. 답은 비동기로 오므로 최신 커밋에는
   아직 없을 수 있다. 선언과 적용을 비교하는 검사는 이것을 읽는다. */
let seatedRecord = null;

/** 실제 위치까지 채워진 마지막 레코드. 없으면 null. */
export const seated = () => seatedRecord;

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
 * 이 표면을 지금 표시하는가.
 *
 * DOM 은 네이티브 표면 위에 그릴 수 없으므로, 표면 위에 무언가를 그리는 동안
 * capture-hidden 으로 표면을 숨기고 DOM 이 스냅샷을 그린다.
 */
const effectiveVisible = (slot) => slot.dataset.nativeCaptureHidden !== "true";

/* 이 커밋이 마지막 갱신인지, 갱신이 이어지는 중인지.
   경계를 끄는 동안 매 프레임 커밋이 발생하고 놓으면 멈춘다. 뷰는 끄는 동안 divider 에
   data-dragging 을 설정하고 놓을 때 마지막 렌더 전에 제거하므로, 마지막 렌더는 true 를
   반환한다.

   표면을 그리는 쪽은 이 값으로 적용 방식을 선택한다. 변경 원인이 아니라 갱신이 더
   있는지만 전달한다. */
const settled = () => plane.querySelector(".sp-divider[data-dragging]") === null;

/** 표면 슬롯 목록. 판이 기록한 data 속성을 그대로 읽는다. */
const slots = () =>
  plane.querySelectorAll("[data-native-surface][data-native-surface-id]");

/**
 * 현재 슬롯을 측정해 커밋한다. 지연이 설정되어 있으면 그만큼 늦게 적용한다.
 *
 * 호출로만 동작한다. 위치 변경을 감시하지 않고, 위치를 정한 쪽이 호출한다.
 */
export function publish(rects) {
  const mine = ++seq;
  const host = plane.getBoundingClientRect();
  const snapshot = [];
  for (const slot of slots()) {
    const r = slot.getBoundingClientRect();
    const frame = { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height };
    const id = slot.dataset.nativeSurfaceId;
    const seat = cardOf(slot);
    const card = rects?.get(seat);
    if (card) {
      insets.set(id, {
        card: seat,
        left: frame.x - card.x,
        top: frame.y - card.y,
        width: card.w - frame.w,
        height: card.h - frame.h,
      });
    }
    snapshot.push({
      id,
      layer: Number(slot.dataset.nativeLayer),
      title: slot.dataset.nativeTitle,
      plugin: slot.dataset.nativePlugin,
      dim: slot.dataset.nativeDim === "true",
      visible: effectiveVisible(slot),
      frame,
    });
  }
  deliver(mine, snapshot);
}

/**
 * 이 스냅샷을 커밋한다. 커밋 지연이 있으면 그만큼 늦춘다.
 *
 * 지연은 실제 애플리케이션에서 판이 그려진 뒤 표면이 따라오기까지의 시차를 만들어
 * 본다. 늦춘 커밋은 앞선 커밋을 대신하므로 이전 것을 취소한다.
 */
function deliver(mine, snapshot) {
  clearTimeout(timer);
  const send = () => commit(mine, snapshot, settled());
  if (knobs.latency === 0) return send();
  timer = setTimeout(send, knobs.latency);
  return undefined;
}

/**
 * 아직 렌더링하지 않은 배치를 커밋한다.
 *
 * 판이 배치를 변경하고 아직 렌더링하지 않았을 때 호출한다. 카드 사각형은 판이
 * 전달하고, 그 안에서 슬롯의 위치는 직전 커밋에서 측정한 여백으로 계산한다.
 *
 * 여백을 모르는 표면이 하나라도 있으면 false 를 반환한다. 호출한 쪽은 렌더링한 뒤
 * 측정하는 경로로 처리한다.
 */
export function publishAhead(rects) {
  const seats = [];
  for (const slot of slots()) {
    const id = slot.dataset.nativeSurfaceId;
    const inset = insets.get(id);
    const card = inset && rects.get(inset.card);
    if (!card || inset.card !== cardOf(slot)) return false;
    seats.push({
      id,
      layer: Number(slot.dataset.nativeLayer),
      title: slot.dataset.nativeTitle,
      plugin: slot.dataset.nativePlugin,
      dim: slot.dataset.nativeDim === "true",
      visible: effectiveVisible(slot),
      frame: {
        x: card.x + inset.left,
        y: card.y + inset.top,
        w: card.w - inset.width,
        h: card.h - inset.height,
      },
    });
  }
  if (seats.length === 0) return false;
  // 지연은 두 길에 같이 걸린다. 한쪽만 걸면 그 손잡이가 끄는 동안에는 아무 일도
  // 하지 않고, 그 상태를 만들려고 있는 손잡이가 그 상태를 만들지 못한다.
  return deliver(++seq, seats) ?? true;
}

/** 네이티브 상태를 쓰는 유일한 함수. 시퀀스가 낮은 스냅샷은 거부한다. */
function commit(mine, snapshot, final) {
  if (mine < applied) return;
  applied = mine;
  const record = { seq: mine, settled: final, surfaces: [] };
  const kinds = app.kinds;
  for (const s of snapshot) {
    // 호스트가 없으면 이 모듈이 표면을 모사하므로 적용 위치도 여기서 정한다.
    // 호스트가 있으면 호스트가 실제로 앉힌 자리를 답으로 주고, 아래에서 그것으로
    // 바꿔 넣는다.
    const seat = { ...s.frame, x: s.frame.x + knobs.skew, y: s.frame.y + knobs.skew };
    const declared = {
      id: s.id, plugin: s.plugin, layer: s.layer, declared: s.frame, applied: seat,
      visible: s.visible, dim: s.dim,
      // 표면이 표시할 대상은 플러그인이 정한다. 호스트가 종류로 분기하면 플러그인을
      // 추가할 때마다 호스트를 수정해야 한다.
      surface: plugin(s.plugin).surface(s.id),
    };
    // 호스트가 네이티브로 그리는 표면에는 모사 요소를 만들지 않는다. 둘 다 만들면
    // DOM 사본이 네이티브 뷰 아래에 남는다.
    if (kinds.includes(s.plugin)) {
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
    el.dataset.dim = String(s.dim);
    // 라벨은 값이 바뀔 때만 갱신한다. 커밋은 프레임마다 발생하지만 제목과 레이어는
    // 거의 바뀌지 않으므로, 매번 쓰면 표면 내용이 프레임마다 다시 생성된다.
    const label = `<b>${s.title}</b><br>네이티브 표면 · ${s.plugin} · layer ${s.layer}`;
    if (el.dataset.label !== label) { el.innerHTML = label; el.dataset.label = label; }
    record.surfaces.push(declared);
  }
  for (const [id, el] of drawn) {
    if (!record.surfaces.some((x) => x.id === id)) { el.remove(); drawn.delete(id); }
  }
  latestRecord = record;
  // 무엇을 호스트에 보낼지는 이 모듈이 정하지 않는다. 이 판의 표면만으로는 부족하고,
  // 다른 스페이스의 표면도 살아 있어야 한다.
  //
  // 수신자의 반환값을 그대로 반환한다. 렌더링 전에 커밋한 쪽이 이 값을 기다린다.
  const answered = listener?.(record);
  if (answered && typeof answered.then === "function") {
    return answered.then((placed) => {
      seat(record, placed);
      return placed;
    });
  }
  // 호스트가 없으면 이 모듈이 앉힌 자리가 곧 실제 자리다. 호스트가 있는데 답이
  // 없으면 직전과 같은 요청이라 전송되지 않은 것이고, 마지막으로 답한 자리가 그대로
  // 유효하다. 그때 이 레코드를 넣으면 모사한 자리가 실제 자리로 기록된다.
  if (!native) seatedRecord = record;
  return answered;
}

/**
 * 호스트가 답한 실제 위치를 레코드에 넣는다.
 *
 * 선언한 사각형과 실제로 앉은 자리는 다르다. 호스트가 디스플레이 픽셀에 맞춰
 * 정렬하기 때문이다. 그 차이를 검증기가 잴 수 있어야 하므로 답을 그대로 기록한다.
 */
function seat(record, placed) {
  if (!Array.isArray(placed)) return;
  const at = new Map(placed.map((p) => [p.id, p]));
  for (const s of record.surfaces) {
    const now = at.get(s.id);
    if (now) s.applied = { x: now.x, y: now.y, w: now.w, h: now.h };
  }
  if (!seatedRecord || record.seq >= seatedRecord.seq) seatedRecord = record;
}

/* 손잡이가 바뀌었음을 듣는 쪽. 문서가 등록한다. */
let onKnob = () => {};

/** 손잡이가 바뀌면 fn 을 호출한다. */
export function onKnobChange(fn) {
  onKnob = fn;
}

/** 손잡이 하나를 바꾸고 알린다. 값은 다음 렌더에서 읽힌다. */
export function setKnob(name, value) {
  knobs[name] = value;
  onKnob();
}

/**
 * 표면을 숨기고 같은 위치에 `.standin` 을 표시한다.
 *
 * 네이티브 표면은 OS 뷰이므로 DOM 이 그 위에 그릴 수 없다. DOM 을 표면 위에 그리는
 * 동안 capture-hidden 으로 표면을 숨기고 `.standin` 을 대신 표시하며, 표면 갱신은
 * 그동안 중단하고 종료 시 복원한다.
 *
 * `.standin` 은 표면과 동일하게 표시한다. 표면을 숨기는 동안 화면이 변하면 안 된다.
 *
 * `over` 를 지정하면 그 영역과 겹치는 표면만 숨긴다. 드롭 구획은 판 전체를 대상으로
 * 하지만, 선택 레이어는 작아서 전체를 숨기면 겹치지 않는 표면의 갱신까지 중단된다.
 */
export function standIn(on, over) {
  const area = over ? plane.getBoundingClientRect() : null;
  const kinds = app.kinds;
  for (const slot of slots()) {
    // 네이티브 표면은 실행 중인 페이지와 프로그램을 표시한다. DOM 을 그리려고 숨기면
    // 사용자가 보던 화면이 정지 이미지로 바뀌므로 숨기지 않는다.
    if (kinds.includes(slot.dataset.nativePlugin)) {
      delete slot.dataset.nativeCaptureHidden;
      slot.innerHTML = "";
      continue;
    }
    let hide = on;
    if (hide && over) {
      const r = slot.getBoundingClientRect();
      hide = over.x < r.right - area.left && over.x + over.w > r.left - area.left
          && over.y < r.bottom - area.top && over.y + over.h > r.top - area.top;
    }
    if (hide) slot.dataset.nativeCaptureHidden = "true";
    else delete slot.dataset.nativeCaptureHidden;
    slot.innerHTML = "";
    if (!hide) continue;

    // 표면이 마지막으로 표시한 내용을 복제한다. 모델에서 다시 만들면 숨기는 시점이
    // 아니라 현재 모델을 표시하고, 커밋 지연 중에는 두 값이 다르다.
    const id = slot.dataset.nativeSurfaceId;
    const shown = drawn.get(id);
    if (!shown) continue;
    const el = document.createElement("div");
    el.className = "standin";
    el.innerHTML = shown.innerHTML;
    // 표면이 있던 위치에 배치한다. 선언 위치에 두면 적용 오차만큼 어긋난다.
    const rec = latestRecord?.surfaces.find((x) => x.id === id);
    if (rec) el.style.transform =
      `translate(${rec.applied.x - rec.declared.x}px,${rec.applied.y - rec.declared.y}px)`;
    slot.appendChild(el);
  }
  publish();
}
