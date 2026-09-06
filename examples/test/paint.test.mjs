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
import { frames, readFrame, writePNG } from "./frame.mjs";
import { area, bare } from "./surface.mjs";

/**
 * 흔들 경계와 폭.
 *
 * 첫 값은 표면이 문서를 렌더링할 때까지 기다리는 시간이다. 렌더링 전의 표면은 이
 * 검사가 찾는 것과 같은 흰색이므로, 기다리지 않으면 기동 중인 상태를 결함으로 센다.
 *
 * 예제의 초기 배치는 고정되어 있다. x:2 는 터미널 카드의 왼쪽 경계, y:1 은 그
 * 아래 경계다. 둘 다 터미널 표면이 커졌다 작아진다. 누른 채로 왕복하므로 경계는
 * 원래 위치로 돌아온다. 경계를 좌표가 아니라 이름으로 지정하므로 창의 크기가 달라도
 * 빗나가지 않는다.
 */
const DRIVES = {
  "vertical boundary": "5000,x,2,-250,0,48,15",
  "horizontal boundary": "5000,y,1,0,180,48,15",
};

/**
 * 경계가 움직였다고 판정할 표면 넓이의 변화량.
 *
 * 누름이 경계를 빗나가면 이 값은 0 에 가깝다. 경계가 최소 카드 크기에 걸려 있어도
 * 마찬가지다. 그때 렌더링 검사는 아무것도 검사하지 않고 통과하므로, 먼저 경계가
 * 실제로 움직였는지 확인한다. 가장 적게 움직인 세로 끌기가 7000 이상이다.
 */
const MOVED = 2000;

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
        let least = Infinity;
        let most = 0;
        for (const path of files) {
          const frame = readFrame(path);
          const n = bare(frame);
          if (n > 0) seen++;
          if (n > worst.n) worst = { n, path };
          const size = area(frame);
          least = Math.min(least, size);
          most = Math.max(most, size);
        }
        assert.ok(
          most - least >= MOVED,
          `the terminal surface changed by ${most - least} while the boundary was ` +
            `shaken, so the boundary did not move:\n${run.log}`,
        );
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
