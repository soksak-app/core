// 닫은 프로젝트 창이 그 창과 웹뷰, 공용 라이브러리가 창과 웹뷰에 붙인 객체, 페이지의 WebContent 프로세스를 남기지
// 않는지 검사한다.
//
// diagnostics.native.objects 는 라이브러리 객체의 살아 있는 수를 애플리케이션이 이벤트 하나를 처리한 뒤에 센다. 닫은
// 창의 객체는 그 창을 닫은 이벤트 반복의 자동 해제 풀이 비워질 때 해제되고, 풀은 애플리케이션이 이벤트를 처리할 때
// 비워지므로, 검사는 사용자 입력 없이 그 해제를 잰다. AppKit 은 화면에 있던 창을 닫기 애니메이션이 끝날 때까지
// 유지하고 풀을 비우는 동안 자동 해제된 객체를 다음 비우기에서 해제하므로, 마지막 창을 닫은 뒤에는 처음 수를 equal
// 로 주고, 라이브러리가 이벤트를 넣어 풀을 비울 때마다 비교한 결과를 받는다.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, fresh, keepCommonSettings, open } from "./app.mjs";

const CYCLES = 4;

const counts = (s, equal) => s.request("diagnostics.native.objects", equal ? { equal } : {});

for (const app of Object.values(APPS)) {
  test(`${app.name}: closed project windows release their windows, webviews, attached native objects and page processes`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-release-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "a project window did not close");
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
    });
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });

    const before = await counts(s);
    const measured = [];
    const pageProcesses = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const label = `cycle ${cycle}`;
      const opened = await s.run("core.project.open", { root, color: "#7db4ff" });
      const windows = await s.windows(2, `${label}: the project window did not open`);
      const child = s.on(windows.find((w) => w.window !== s.window).window);
      await child.until("core.project", (project) => project?.id === opened.id, `${label}: the project did not become active`);
      await child.until("core.surfaces", (surfaces) => surfaces.some((surface) => surface.visible),
        `${label}: the project window showed no surface`);
      await child.presented();
      const { pageProcess } = await child.get("host.window");
      assert.ok(Number.isInteger(pageProcess) && pageProcess > 0, `${label}: the project window has no page process: ${pageProcess}`);
      pageProcesses.push(pageProcess);
      const showing = await counts(s);
      measured.push(showing);
      // 열린 창의 합성 뷰, 표면, 입력 등록이 세어져야 닫은 뒤의 값이 해제를 나타낸다.
      assert.ok(showing.windowCompositions > before.windowCompositions && showing.surfaceHosts > before.surfaceHosts &&
        showing.inputRegistrations > before.inputRegistrations,
        `${label}: the open project window is not counted: before ${JSON.stringify(before)}, open ${JSON.stringify(showing)}`);
      await child.close();
      await s.windows(1, `${label}: the project window did not close`);
      await s.run("core.project.close", { id: opened.id });
      await s.until("core.projects", (projects) => !projects.some((project) => project.id === opened.id),
        `${label}: the project did not leave the registry`);
    }
    // 수가 10초 안에 before 로 돌아오지 않으면 요청이 그때의 수를 담은 오류로 실패한다.
    const after = await counts(s, before).catch((error) => {
      throw new Error(`${app.name}: ${CYCLES} closed project windows left native objects: ${error.message}; ` +
        `before ${JSON.stringify(before)}, while open ${JSON.stringify(measured)}`);
    });
    t.diagnostic(`${app.name}: before ${JSON.stringify(before)}, open ${JSON.stringify(measured)}, after ${JSON.stringify(after)}`);
    assert.deepEqual(after, before);
    // WebKit 은 페이지가 모두 해제된 WebContent 프로세스를 끝낸다. 프로세스는 수가 돌아온 뒤에 끝날 수 있으므로 종료를
    // 기다린다.
    for (const pid of pageProcesses) {
      await s.request("diagnostics.process.exit", { pid }).catch((error) => {
        throw new Error(`${app.name}: the page process of a closed project window is still running: ${error.message}; ` +
          `page processes ${JSON.stringify(pageProcesses)}`);
      });
    }
  });
}
