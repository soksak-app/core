// 경계를 흔드는 동안 표면에 렌더링되지 않은 영역이 나타나는지 검사한다.
//
// 웹뷰는 레이아웃한 영역만 렌더링하고 나머지는 흰색으로 채운다. 터미널 표면과 그
// 표면이 놓인 행은 모두 어두우므로, 그 행의 흰 픽셀이 렌더링되지 않은 영역이다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, drag, fresh, open } from "./app.mjs";
import { frames, readFrame } from "./frame.mjs";
import { area, bare } from "./surface.mjs";

/**
 * 흔들 경계와 폭.
 *
 * 예제의 초기 배치는 고정되어 있다. x:2 는 터미널 카드의 왼쪽 경계, y:1 은 그 아래
 * 경계다. 둘 다 터미널 표면이 커졌다 작아진다. 누른 채로 왕복하므로 경계는 원래 위치로
 * 돌아온다. 경계를 좌표가 아니라 번호로 지정하므로 창의 크기가 달라도 빗나가지 않는다.
 */
const PLANS = {
  "vertical boundary": { axis: "x", line: 2, dx: -250, dy: 0, ms: 48, times: 15 },
  "horizontal boundary": { axis: "y", line: 1, dx: 0, dy: 180, ms: 48, times: 15 },
};

/**
 * 경계가 움직였다고 판정할 표면 넓이의 변화량.
 *
 * 경계가 최소 카드 크기에 걸려 있으면 이 값은 0 에 가깝고, 그때 렌더링 검사는 아무것도
 * 검사하지 않고 통과하므로 먼저 경계가 실제로 움직였는지 확인한다. 가장 적게 움직인 세로
 * 끌기가 7000 이상이다.
 */
const MOVED = 2000;

for (const app of Object.values(APPS)) {
  for (const [which, plan] of Object.entries(PLANS)) {
    test(`${app.name}: shaking the ${which} exposes no unrendered area`, async (t) => {
      const s = await open(t, app);
      if (!s) return t.skip(`${app.binary} is not built`);
      await fresh(s);
      // 페이지의 검증기는 렌더마다 돌고 결과를 core.verify 로 공개한다. 끌기 동안의 모든 결과를 모은다.
      const verify = await s.collect("core.verify");
      const run = await drag(t, s, plan, { capture: true });
      const verified = (await verify.stop()).filter(Boolean);
      assert.ok(verified.length > 0, "the page never reported a check");
      const failed = verified.filter((result) => result.failed > 0);
      assert.deepEqual(failed.map((result) => result.rows.filter((row) => !row.ok)), [],
        "the page reported a failed check");

      const files = frames(run.frames);
      assert.ok(files.length > 60, `only ${files.length} frames were recorded`);
      let worst = { n: 0, frame: -1 };
      let seen = 0;
      let least = Infinity;
      let most = 0;
      files.forEach((path, index) => {
        const frame = readFrame(path);
        const n = bare(frame);
        if (n > 0) seen++;
        if (n > worst.n) worst = { n, frame: index };
        const size = area(frame);
        least = Math.min(least, size);
        most = Math.max(most, size);
      });
      assert.ok(most - least >= MOVED,
        `the terminal surface changed by ${most - least} while the boundary was shaken, so the boundary did not move`);
      assert.equal(worst.n, 0,
        `${seen} of ${files.length} frames show unrendered area; the worst is ${worst.n} pixels in frame ${worst.frame}`);
    });
  }
}
