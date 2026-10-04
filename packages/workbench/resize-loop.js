// ResizeObserver 루프가 한 frame 안에 전달하지 못한 관찰을 기록하는 진단 기록기(G1.4-115).
//
// WebKit 은 ResizeObserver callback 이 그 frame 의 관찰 round 가 이미 지나간 요소의 크기를 바꾸면 그 관찰을 다음
// frame 으로 미루고 "ResizeObserver loop completed with undelivered notifications." 를 error 이벤트로 알린다.
// 미룬 관찰은 다음 frame 의 관찰 round 에 전달되므로, 오류 뒤 그 frame 의 callback 이 받은 대상과 크기를 모아
// 그다음 frame 에 report 로 보낸다. 오류가 난 frame 에서 실행된 callback 과 그 observer 를 만든 코드도 보내므로,
// 관찰 round 가 지나간 요소의 크기를 바꾼 callback 을 찾을 수 있다(F32). 진단 빌드에서만 실행된다.

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

/**
 * view 의 ResizeObserver 를 기록하는 하위 클래스로 바꾸고, 루프 오류 뒤 다음 frame 에 전달된 관찰을 report(line) 로
 * 보낸다. 바꾼 뒤 만든 observer 만 기록한다.
 */
export function watchResizeLoop(view, report, locate = creator) {
  const Native = view.ResizeObserver;
  let collected = null;
  // 이번 frame 에 실행된 callback. 다음 frame 의 rAF 가 비우며, 그 rAF 는 다음 frame 의 관찰 round 보다 먼저 실행된다.
  let ran = [];
  // 이번 frame 의 첫 callback 뒤에 일어난 DOM 변경. 크기를 바꾼 코드가 callback 밖에 있어도 그 대상을 밝힌다(F32).
  let changed = [];
  let clearing = false;
  const mutations = new view.MutationObserver((records) => {
    if (!clearing) return;
    for (const record of records) {
      const what = record.type === "attributes" ? `attributes ${record.attributeName}` : record.type;
      changed.push(`${what} of ${record.target.nodeType === 1 ? describe(record.target) : record.target.nodeName}`);
    }
  });
  mutations.observe(view.document, { subtree: true, childList: true, attributes: true, characterData: true });
  const sized = (entry) => `${describe(entry.target)} ${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
  view.ResizeObserver = class extends Native {
    constructor(callback) {
      const label = locate();
      super((entries, observer) => {
        if (collected) {
          for (const entry of entries) collected.push(sized(entry));
        }
        // 시각은 performance trace 의 배치 단계와 같은 시계다. 오류가 난 frame 의 callback 과 배치 그리기를 대조한다.
        ran.push(`${label} at ${view.performance.now().toFixed(1)}ms on ${[...entries].map(sized).join(", ")}`);
        if (!clearing) {
          clearing = true;
          view.requestAnimationFrame(() => {
            ran = [];
            changed = [];
            clearing = false;
          });
        }
        return callback(entries, observer);
      });
    }
  };
  view.addEventListener("error", (event) => {
    if (!/^ResizeObserver loop/.test(event.message) || collected) return;
    report(`resize observer loop: this frame ran ${ran.length ? ran.join("; ") : "no callback"}`);
    // 변경 기록은 microtask 로 전달되므로 오류 시점까지의 기록을 먼저 가져온다.
    for (const record of mutations.takeRecords()) {
      const what = record.type === "attributes" ? `attributes ${record.attributeName}` : record.type;
      changed.push(`${what} of ${record.target.nodeType === 1 ? describe(record.target) : record.target.nodeName}`);
    }
    report(`resize observer loop: this frame changed ${changed.length ? [...new Set(changed)].join(", ") : "nothing"}`);
    // 다음 frame 의 rAF 는 그 frame 의 관찰 round 전에 실행되고, 그다음 frame 의 rAF 는 그 round 뒤에 실행된다.
    view.requestAnimationFrame(() => {
      collected = [];
      view.requestAnimationFrame(() => {
        const lines = collected;
        collected = null;
        report(`resize observer loop: the next frame delivered ${lines.length ? lines.join(", ") : "no observation"}`);
      });
    });
  });
}
