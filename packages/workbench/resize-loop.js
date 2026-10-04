// ResizeObserver 루프가 한 frame 안에 전달하지 못한 관찰을 기록하는 진단 기록기(G1.4-115).
//
// WebKit 은 ResizeObserver callback 이 그 frame 의 관찰 round 가 이미 지나간 요소의 크기를 바꾸면 그 관찰을 다음
// frame 으로 미루고 "ResizeObserver loop completed with undelivered notifications." 를 error 이벤트로 알린다.
// 미룬 관찰은 다음 frame 의 관찰 round 에 전달되므로, 오류 뒤 그 frame 의 callback 이 받은 대상과 크기를 모아
// 그다음 frame 에 report 로 보낸다. 진단 빌드에서만 실행된다.

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
export function watchResizeLoop(view, report) {
  const Native = view.ResizeObserver;
  let collected = null;
  view.ResizeObserver = class extends Native {
    constructor(callback) {
      super((entries, observer) => {
        if (collected) {
          for (const entry of entries) {
            collected.push(`${describe(entry.target)} ${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`);
          }
        }
        return callback(entries, observer);
      });
    }
  };
  view.addEventListener("error", (event) => {
    if (!/^ResizeObserver loop/.test(event.message) || collected) return;
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
