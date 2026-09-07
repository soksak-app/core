// 경계를 끄는 동안 네이티브 표면이 자기 카드 밖에 그려지는지 검사한다.
//
// 규칙은 하나이고 여유가 없다 — 네이티브 표면은 자기 카드가 그려진 자리에만
// 그려진다. 판은 표면의 자리를 그리기 전에 호스트에 알리고, 호스트는 뷰를 그 자리로
// 옮긴다. 페이지의 그리기와 뷰의 이동은 서로 다른 합성 층에 실리므로 두 층은 한
// 프레임 어긋나고, 그 한 프레임 동안 표면은 카드가 아직 가지 않은 자리에 그려진다.
// 어긋남의 크기는 경계가 한 걸음에 움직인 거리이므로 끄는 속도에 따라 커진다.
//
// 커밋 안의 숫자로는 보이지 않는다. 선언한 자리와 호스트가 앉힌 자리는 정확히 같고,
// 그려진 요소와 선언한 자리도 정확히 같다. 어긋나는 것은 그 둘이 화면에 실리는
// 시각이므로 합성된 픽셀로만 잰다. 이 검사가 그 일을 한다.
//
// 애플리케이션이 빌드되어 있지 않으면 건너뛴다.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { APPS, nothingRecorded, shakeTwice } from "./app.mjs";
import { frames, readFrame, writePNG } from "./frame.mjs";
import { outside } from "./outside.mjs";

/**
 * 사람이 끄는 속도로 끈다.
 *
 * 한 걸음이 화면 갱신 하나이고, 250pt 를 400ms 에 지나면 한 걸음이 10pt 다. 손으로
 * 끄는 속도가 그 언저리다. 더 느리게 끌면 어긋남도 함께 줄어들어, 결함이 아니라
 * 끄는 속도를 재게 된다.
 */
const DRIVE = "5000,x,2,-250,0,400,2";

/** 재지 못한 프레임이 이보다 많으면 이 실행은 아무것도 검사하지 않은 것이다. */
const READ = 0.5;

for (const [name, binary] of Object.entries(APPS)) {
  test(`${name}: a surface is drawn only where its own card is drawn`, async (t) => {
    const run = await shakeTwice(binary, DRIVE);
    if (!run) return t.skip(`${binary} is not built`);
    let keep = false;
    try {
      assert.ok(
        !nothingRecorded(run.log),
        `the window server delivered no frames, so nothing was measured:\n${run.log}`,
      );
      const files = frames(run.into);
      assert.ok(files.length > 30, `only ${files.length} frames were recorded:\n${run.log}`);

      let worst = { out: 0, path: "", at: null };
      let read = 0;
      let broke = 0;
      for (const path of files) {
        const at = outside(readFrame(path));
        if (!at) continue;
        read++;
        if (at.out <= 0) continue;
        broke++;
        if (at.out > worst.out) worst = { out: at.out, path, at };
      }
      // 프레임의 절반도 읽지 못했으면 표면이나 카드를 찾지 못한 것이고, 그때 0 은
      // 위반이 없다는 뜻이 아니라 재지 못했다는 뜻이다.
      assert.ok(
        read > files.length * READ,
        `only ${read} of ${files.length} frames could be measured, so this run checked ` +
          `nothing. The surface or its card was not found in the rest.\n${run.log}`,
      );

      if (broke > 0) {
        keep = true;
        const shown = join(process.cwd(), `${name}-outside.png`);
        writePNG(readFrame(worst.path), shown);
        const { at } = worst;
        assert.fail(
          `${broke} of ${read} measured frames draw the surface outside its own card. ` +
            `The worst is ${worst.out.toFixed(1)}pt out` +
            (at.onNeighbour > 0
              ? `, ${at.onNeighbour.toFixed(1)}pt of it over the neighbouring card`
              : "") +
            `: the card spans ${at.card.l}..${at.card.r} and the surface ${at.surface.l}..` +
            `${at.surface.r} on row ${at.row}, at ${at.scale} pixels to the point. ` +
            `That frame is written to ${shown}, and the run's frames are kept in ${run.into}.`,
        );
      }
    } finally {
      if (!keep) run.clean();
    }
  });
}
