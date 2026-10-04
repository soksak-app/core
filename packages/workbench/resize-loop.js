// ResizeObserver 루프가 한 frame 안에 전달하지 못한 관찰을 기록하는 진단 기록기(G1.4-115).
//
// WebKit 은 ResizeObserver callback 이 그 frame 의 관찰 round 가 이미 지나간 요소의 크기를 바꾸면 그 관찰을 다음
// frame 으로 미루고 "ResizeObserver loop completed with undelivered notifications." 를 error 이벤트로 알린다.
// 미룬 관찰은 다음 frame 의 관찰 round 에 전달되므로, 오류 뒤 그 frame 의 callback 이 받은 대상과 크기를 모아
// 그다음 frame 에 report 로 보낸다. 오류가 난 frame 에서 실행된 callback 과 그 observer 를 만든 코드도 보내므로,
// 관찰 round 가 지나간 요소의 크기를 바꾼 callback 을 찾을 수 있다(F32). 진단 빌드에서만 실행된다.
//
// DOM 변경은 관찰 round 의 callback slot 별로 나눈다(F43). slot 은 callback 하나와 그 뒤 microtask checkpoint 이며,
// 다음 callback 직전에 takeRecords 로 가져온 기록과 그 사이 MutationObserver 에 전달된 기록이 그 slot 의 변경이다.
// error 이벤트는 round 가 끝난 뒤 보내지므로 그때 가져온 기록은 마지막 slot 의 변경이고, 그 뒤 다음 frame 의
// rAF 까지 전달된 기록은 round 뒤의 변경이다.

/** observer 를 만든 코드의 위치. stack 에서 이 파일 밖의 첫 줄이다. */
function creator() {
  // 기본값: stack 이 없는 엔진에는 위치 줄이 없고, 그때는 위치를 알 수 없음을 그대로 적는다.
  const lines = (new Error().stack ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  // 기본값: 이 파일 밖의 줄이 없으면 위치를 알 수 없음을 그대로 적는다.
  return lines.find((line) => !line.includes("resize-loop.js") && !/^Error\b/.test(line)) ?? "unknown creator";
}

/** 관찰 대상을 로그에서 알아볼 수 있게 적는다. */
function describe(element) {
  let text = element.tagName.toLowerCase();
  if (element.id) text += `#${element.id}`;
  for (const name of [...element.classList].slice(0, 2)) text += `.${name}`;
  for (const attribute of ["data-expose", "data-surface-id", "data-card-id"]) {
    const value = element.getAttribute(attribute);
    if (value !== null) text += `[${attribute}=${value}]`;
  }
  return text;
}

/** 변경 기록을 로그에서 알아볼 수 있게 적는다. */
function change(record) {
  const what = record.type === "attributes" ? `attributes ${record.attributeName}` : record.type;
  return `${what} of ${record.target.nodeType === 1 ? describe(record.target) : record.target.nodeName}`;
}

/** 변경 목록을 같은 항목 하나로 줄여 적는다. */
function changes(list) {
  return list.length ? [...new Set(list)].join(", ") : "nothing";
}

/**
 * view 의 ResizeObserver 를 기록하는 하위 클래스로 바꾸고, 루프 오류가 난 frame 의 callback slot 별 변경과 round 뒤의
 * 변경, 다음 frame 에 전달된 관찰을 report(line) 로 보낸다. 바꾼 뒤 만든 observer 만 기록한다.
 */
export function watchResizeLoop(view, report, locate = creator) {
  const Native = view.ResizeObserver;
  let collected = null;
  // 이번 frame 의 첫 callback 에서 아직 전달되지 않았던 변경. 첫 callback 전에 전달된 기록은 이전 frame 의 것과
  // 구별되지 않으므로 담지 않는다.
  let before = [];
  // 이번 frame 에 실행된 callback slot. 다음 frame 의 rAF 가 비우며, 그 rAF 는 다음 frame 의 관찰 round 보다 먼저 실행된다.
  let slots = [];
  // 루프 오류 뒤 다음 frame 의 rAF 까지 일어난 변경. 오류가 없으면 null 이다.
  let after = null;
  let clearing = false;
  /** 지금 기록이 속하는 목록. 오류 뒤면 round 뒤, round 안이면 마지막 slot, 첫 callback 직전이면 round 전이다. */
  const current = () => {
    if (after) return after;
    if (clearing) return slots.at(-1).changed;
    return before;
  };
  const mutations = new view.MutationObserver((records) => {
    // 첫 callback 전에 전달된 기록은 담지 않는다(before 참고).
    if (!after && !clearing) return;
    const into = current();
    for (const record of records) into.push(change(record));
  });
  mutations.observe(view.document, { subtree: true, childList: true, attributes: true, characterData: true });
  /** 아직 전달되지 않은 기록을 지금 slot 의 변경으로 가져온다. */
  const take = (into) => {
    for (const record of mutations.takeRecords()) into.push(change(record));
  };
  const sized = (entry) => `${describe(entry.target)} ${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
  view.ResizeObserver = class extends Native {
    constructor(callback) {
      // observer 를 만든 시각도 적는다. 관찰 round 도중에 만든 observer 는 첫 관찰의 일부를 다음 frame 으로 미룬다(F32).
      const label = `${locate()} created at ${view.performance.now().toFixed(1)}ms`;
      super((entries, observer) => {
        if (collected) {
          for (const entry of entries) collected.push(sized(entry));
        }
        // 이 callback 전까지의 기록은 앞 slot, 첫 callback 이면 round 전의 변경이다.
        take(current());
        // 시각은 performance trace 의 배치 단계와 같은 시계다. 오류가 난 frame 의 callback 과 배치 그리기를 대조한다.
        slots.push({ ran: `${label} at ${view.performance.now().toFixed(1)}ms on ${[...entries].map(sized).join(", ")}`, changed: [] });
        if (!clearing) {
          clearing = true;
          view.requestAnimationFrame(() => {
            before = [];
            slots = [];
            clearing = false;
          });
        }
        return callback(entries, observer);
      });
    }
  };
  view.addEventListener("error", (event) => {
    if (!/^ResizeObserver loop/.test(event.message) || collected || after) return;
    // error 이벤트는 round 뒤에 보내지므로 지금까지의 기록은 마지막 slot 의 변경이다.
    take(current());
    report(`resize observer loop: before the round, undelivered at the first callback: ${changes(before)}`);
    if (!slots.length) report("resize observer loop: this frame ran no callback");
    slots.forEach((slot, index) => {
      report(`resize observer loop: in the round callback ${index + 1} ran ${slot.ran}, then changed ${changes(slot.changed)}`);
    });
    after = [];
    // 다음 frame 의 rAF 는 그 frame 의 관찰 round 전에 실행되고, 그다음 frame 의 rAF 는 그 round 뒤에 실행된다.
    view.requestAnimationFrame(() => {
      take(after);
      report(`resize observer loop: after the round changed ${changes(after)}`);
      after = null;
      collected = [];
      view.requestAnimationFrame(() => {
        const lines = collected;
        collected = null;
        report(`resize observer loop: the next frame delivered ${lines.length ? lines.join(", ") : "no observation"}`);
      });
    });
  });
}
