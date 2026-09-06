// 창을 최대화한 뒤에도 페이지의 검사가 모두 통과하는지 본다.
//
// 창 자신의 단추가 서는 자리는 창의 크기에서 계산되고, 플랫폼은 창을 다시 배치할
// 때마다 그 단추를 표준 타이틀바의 자리로 되돌린다. 크기가 바뀌기 전만 보면 그
// 되돌림을 놓친다.
//
// 판정은 페이지가 창에게 물어 받은 수치다. 합성된 프레임으로 재지 않는 이유는,
// 포인터가 단추 위에 있으면 플랫폼이 그 자리에 다른 것을 그리기 때문이다.
//
// 애플리케이션이 빌드되어 있지 않으면 건너뛴다. `make examples-verify` 가 먼저
// 빌드한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, shake } from "./app.mjs";

/** 첫 행을 건드리지 않는 끌기. 끌기가 끝나야 애플리케이션이 종료한다. */
const DRIVE = "5000,x,2,-250,0,48,3";

/** 로그에 마지막으로 남은 검증 결과. */
const settled = (log) =>
  log.split("\n").filter((line) => /verify: \d+ (pass|fail)/.test(line)).pop() ?? "";

for (const [name, binary] of Object.entries(APPS)) {
  test(`${name}: maximising the window leaves its own buttons in place`, async (t) => {
    const run = await shake(binary, DRIVE, { zoom: true });
    if (!run) return t.skip(`${binary} is not built`);
    try {
      // 창의 크기가 바뀌는 동안에는 표면이 페이지보다 한 커밋 늦으므로 그때의
      // 검증은 실패한다. 여기서 보는 것은 크기가 정해진 뒤의 결과다.
      const last = settled(run.log);
      assert.match(last, /verify: \d+ pass/, `the page's last check:\n${last || run.log}`);
    } finally {
      run.clean();
    }
  });
}
