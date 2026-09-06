// 경계를 흔드는 동안 표면에 렌더링되지 않은 영역이 나타나는지 검사한다.
//
// 웹뷰는 레이아웃한 영역만 렌더링하고 나머지는 흰색으로 채운다. 터미널 표면과 그
// 표면이 놓인 행은 모두 어두우므로, 그 행의 흰 픽셀이 렌더링되지 않은 영역이다.
//
// 애플리케이션이 빌드되어 있지 않으면 건너뛴다. `make examples-verify` 가 먼저
// 빌드한다.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { APPS, shake } from "./app.mjs";
import { frames, readFrame, pixel, writePNG } from "./frame.mjs";

/**
 * 흔들 경계와 폭.
 *
 * 첫 값은 표면이 문서를 렌더링할 때까지 기다리는 시간이다. 렌더링 전의 표면은 이
 * 검사가 찾는 것과 같은 흰색이므로, 기다리지 않으면 기동 중인 상태를 결함으로 센다.
 *
 * 예제의 초기 배치는 고정되어 있다. 세로 경계는 터미널 카드의 왼쪽, 가로 경계는
 * 터미널 카드의 아래다. 둘 다 터미널 표면이 커졌다 작아진다. 누른 채로 왕복하므로
 * 경계는 원래 위치로 돌아온다.
 */
const DRIVES = {
  "세로 경계": "5000,404,294,-250,0,48,15",
  "가로 경계": "5000,729,479,0,180,48,15",
};

/** 흰색으로 판정할 밝기. */
const PALE = 230;

/** 터미널이 놓인 행. 창 높이에 대한 비율이다. */
const ROW = { from: 0.16, to: 0.52 };

/** 이 프레임에서 해당 행의 흰 픽셀 수. */
function bare(frame) {
  let n = 0;
  for (
    let y = Math.round(frame.height * ROW.from);
    y < frame.height * ROW.to;
    y += 2
  ) {
    for (let x = 2; x < frame.width - 2; x += 2) {
      const [r, g, b] = pixel(frame, x, y);
      if (r > PALE && g > PALE && b > PALE) n++;
    }
  }
  return n;
}

for (const [name, binary] of Object.entries(APPS)) {
  for (const [which, drive] of Object.entries(DRIVES)) {
    test(`${name}: ${which}를 흔들어도 칠해지지 않은 자리가 드러나지 않는다`, async (t) => {
      const run = await shake(binary, drive);
      if (!run) return t.skip(`${binary} 가 없다`);
      try {
        const files = frames(run.into);
        assert.ok(
          files.length > 60,
          `녹화된 프레임이 ${files.length} 장뿐이다:\n${run.log}`,
        );

        let worst = { n: 0, path: "" };
        let seen = 0;
        for (const path of files) {
          const n = bare(readFrame(path));
          if (n > 0) seen++;
          if (n > worst.n) worst = { n, path };
        }
        if (worst.n > 0) {
          // 실패한 프레임을 PNG 로 남긴다.
          const shown = join(process.cwd(), `${name}-bare.png`);
          writePNG(readFrame(worst.path), shown);
          assert.fail(
            `${files.length} 장 중 ${seen} 장에서 렌더링되지 않은 영역이 있다. ` +
              `가장 심한 것은 ${worst.n} 픽셀이고 ${shown} 에 적었다.`,
          );
        }
      } finally {
        run.clean();
      }
    });
  }
}
