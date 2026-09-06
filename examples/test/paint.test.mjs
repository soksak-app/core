// 경계를 흔드는 동안 표면이 칠해지지 않은 자리를 드러내지 않는지 본다.
//
// 웹뷰는 자기가 덮은 자리를 칠한다. 뷰가 커지면 아직 칠하지 못한 자리가 드러나고,
// 그 자리는 웹뷰 자신의 흰색이다. 터미널 표면과 그것이 놓인 줄은 모두 어두우므로,
// 그 줄에 흰 픽셀이 있으면 그것이 드러난 자리다.
//
// 앱이 빌드되어 있지 않으면 건너뛴다. `make examples-verify` 가 먼저 빌드한다.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { APPS, shake } from "./app.mjs";
import { frames, readFrame, pixel, writePNG } from "./frame.mjs";

/**
 * 흔들 경계와 폭.
 *
 * 예제가 처음 그리는 배치는 정해져 있다. 세로 경계는 터미널 카드의 왼쪽을, 가로
 * 경계는 터미널 카드의 아래를 잡는다. 둘 다 터미널 표면이 커졌다 작아지는 쪽이다.
 * 누른 채로 왕복하므로 경계는 제자리로 돌아온다.
 */
const DRIVES = {
  "세로 경계": "3000,404,294,-250,0,48,15",
  "가로 경계": "3000,729,479,0,180,48,15",
};

/** 흰색으로 볼 밝기. */
const PALE = 230;

/** 터미널이 놓인 줄. 창 높이에 대한 비율이다. */
const ROW = { from: 0.16, to: 0.52 };

/** 이 프레임에서 그 줄에 있는 흰 픽셀 수. */
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
          // 어긋난 프레임은 사람이 볼 수 있게 남긴다.
          const shown = join(process.cwd(), `${name}-bare.png`);
          writePNG(readFrame(worst.path), shown);
          assert.fail(
            `${files.length} 장 중 ${seen} 장에서 칠해지지 않은 자리가 보인다. ` +
              `가장 심한 것은 ${worst.n} 픽셀이고 ${shown} 에 적었다.`,
          );
        }
      } finally {
        run.clean();
      }
    });
  }
}
