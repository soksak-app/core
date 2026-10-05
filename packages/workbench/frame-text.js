// 프레임 글자 배율과 첫 행의 높이(docs/spec/native-surfaces.md#title-bar-height).
//
// 배율은 설정이 바뀔 때가 아니라 준비한 배치의 그리기에서 문서에 쓴다. 준비가 그 그리기의 첫 행 높이를 담고 호스트가
// 같은 트랜잭션에서 창 제목줄을 그 높이로 정하므로, 행과 창 단추가 같은 프레임에 바뀐다.

/** 첫 행의 가장 작은 높이(px). app.css 의 --chrome-h 다. */
const CHROME_H = 40;
/** 배율 1 의 행 높이(px). app.css 의 --chrome-row-h 다. */
const CHROME_ROW_H = 36;

/** 문서에 쓴 배율. 쓰기 전에는 app.css 의 :root 값 1 이다. */
let drawn = 1;

function checked(factor) {
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) {
    throw new Error(`frame text factor ${factor} is not a positive finite number`);
  }
  return factor;
}

/**
 * factor 에서 첫 행의 높이(px). app.css 의 --chrome-row 인 round(nearest, max(--chrome-h, --chrome-row-h × factor), 1px)
 * 와 같다. CSS 의 round(nearest) 는 가운데 값에서 큰 쪽을 고르고 Math.round 도 그렇다.
 */
export function chromeRow(factor) {
  return Math.round(Math.max(CHROME_H, CHROME_ROW_H * checked(factor)));
}

/** 문서에 배율을 쓴다. 1 이면 zoom 을 선언하지 않는다(app.css). */
function write(factor) {
  const root = document.documentElement;
  root.style.setProperty("--frame-text", String(factor));
  if (factor === 1) delete root.dataset.frameText;
  else root.dataset.frameText = "";
}

/** 그리기가 배율을 문서에 쓴다. */
export function applyFrameText(factor) {
  write(checked(factor));
  drawn = factor;
}

/** 문서에 쓴 배율. */
export const drawnFrameText = () => drawn;

/**
 * factor 일 때의 문서를 read 로 읽고 그린 배율로 되돌린다. 같은 task 안에서 쓰고 되돌리므로 문서는 그 사이에 아무것도
 * 렌더링하지 않는다. 준비하기 전에 새 배율이 주는 판의 크기를 잴 때 쓴다.
 */
export function measureAt(factor, read) {
  checked(factor);
  if (factor === drawn) return read();
  write(factor);
  try {
    return read();
  } finally {
    write(drawn);
  }
}

/**
 * 판이 없는 창의 첫 행을 그리는 준비한 배치의 단계(layout-queue.js 의 drawPrepared). 준비는 표면 없이 factor 의 첫
 * 행 높이를 담고, 그리기는 판을 지운 뒤(clearPlane) factor 를 쓰고 화면을 그리며(show), 표시는 그린 행의 커밋이다.
 * 라이브러리로의 전환은 그 전에 준비한 판의 그리기를 취소하므로 지금 배율로 이 배치를 그려 취소된 그리기의 배율을 잃지
 * 않고, 같은 그리기에서 라이브러리 화면을 보인다.
 *
 *   publishAhead(rects, seated, titlebar), publish(), frame(work)  compositor.js 와 layout-queue.js 의 함수
 */
export function frameLayout({ factor, publishAhead, publish, frame, clearPlane = () => {}, show = () => {} }) {
  const titlebar = chromeRow(factor);
  return {
    prepare: () => publishAhead(new Map(), new Map(), titlebar),
    draw: () => {
      clearPlane();
      applyFrameText(factor);
      show();
    },
    frame,
    presented: publish,
  };
}
