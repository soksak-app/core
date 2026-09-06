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
  "vertical boundary": "5000,404,294,-250,0,48,15",
  "horizontal boundary": "5000,729,479,0,180,48,15",
};

/** 흰색으로 판정할 밝기. */
const PALE = 230;

/**
 * 터미널 표면의 배경색. settings.js 의 midnight 테마가 --surface 로 주는 값이며,
 * 예제가 기본으로 그리는 테마다.
 *
 * "어두운 초록" 처럼 넓게 잡으면 브라우저 표면이 그리는 글자의 안티에일리어싱
 * 가장자리가 걸린다. 이 검사가 찾는 것은 터미널 표면이므로 그 색만 본다.
 */
const SURFACE = [13, 26, 20];
// 판의 배경 #101117 과 카드 테두리 #2b2e3d 는 초록이 두드러지지 않는다. 표면 색만
// 걸리도록 좁게 잡는다.
const NEAR = 4;
const surface = (px) => px.every((v, i) => Math.abs(v - SURFACE[i]) <= NEAR);

const pale = ([r, g, b]) => r > PALE && g > PALE && b > PALE;

/**
 * 표면 배경과 흰색이 이만큼 안에 맞붙어 있으면 사이에 카드 테두리가 없다.
 *
 * midnight 테마의 통로는 6px 이다. 그만큼 멀리 보면 통로 건너편 표면이 걸리므로
 * 통로보다 짧아야 한다.
 */
const REACH = 3;

/**
 * 이 프레임에서 터미널 표면에 맞붙은 흰 픽셀 수.
 *
 * 터미널 표면의 배경 바로 옆은 카드의 머리, 발, 테두리라 모두 어둡다. 그 배경에
 * 맞붙은 흰색은 그 표면 안에서 아직 렌더링되지 않은 자리뿐이다. 창의 어느 구역인지
 * 알 필요가 없으므로 세로 끌기와 가로 끌기에 같은 기준이 쓰인다.
 */
function bare(frame) {
  let n = 0;
  for (let y = REACH; y < frame.height - REACH; y += 2) {
    for (let x = REACH; x < frame.width - REACH; x += 2) {
      if (!surface(pixel(frame, x, y))) continue;
      if (pale(pixel(frame, x + REACH, y)) || pale(pixel(frame, x - REACH, y)) ||
          pale(pixel(frame, x, y + REACH)) || pale(pixel(frame, x, y - REACH))) {
        n++;
      }
    }
  }
  return n;
}

/** 로그에서 페이지 검증기가 남긴 실패 줄. */
const failures = (log) =>
  log.split("\n").filter((line) => /verify: \d+ fail/.test(line));

for (const [name, binary] of Object.entries(APPS)) {
  for (const [which, drive] of Object.entries(DRIVES)) {
    test(`${name}: shaking the ${which} exposes no unrendered area`, async (t) => {
      const run = await shake(binary, drive);
      if (!run) return t.skip(`${binary} is not built`);
      try {
        const files = frames(run.into);
        assert.ok(
          files.length > 60,
          `only ${files.length} frames were recorded:\n${run.log}`,
        );

        // 페이지의 검증기는 렌더마다 돌고 결과를 애플리케이션 로그로 보낸다. 그
      // 결과가 기계적 판정에 쓰이지 않으면 사람이 읽어야만 알 수 있다.
      assert.match(run.log, /verify: \d+ pass/, `the page never reported a check:\n${run.log}`);
      assert.deepEqual(failures(run.log), [], "the page reported a failed check");

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
