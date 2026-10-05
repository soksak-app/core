// core 창 검사의 시작 배치. diagnostics.fixture 의 기본 배치는 터미널 탭을 가지므로, 준비는 harness 의 prepareFixture 로
// 배치를 연 뒤 그 터미널이 준비될 때까지 기다린다(F25.2 가 core 의 검사를 fixture plugin 으로 바꾸기 전까지 이 모듈이
// 터미널을 안다).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keepCommonSettings, prepareFixture, TRACE } from "@soksak/window-check/app.mjs";

/** 창 검사 터미널의 셸. 로그인 셸의 프로필에 따라 달라지는 프롬프트를 피한다. */
const CHECK_SHELL = fileURLToPath(new URL("./check-shell", import.meta.url));

/**
 * 터미널 카드에 안쪽 왼쪽 사이드바를 둔다. 기본 배치에는 카드 사이드바가 없으므로, 카드 사이드바를 검사하는 검사는
 * 세트 set-files(files.tree, files.bookmarks, list)와 터미널의 card-left 연결을 공통 설정에 더한다. 검사가 끝나면
 * keepCommonSettings 가 세트와 연결을 함께 되돌리므로 호출자는 sets 를 따로 초기화하지 않는다.
 */
export async function terminalCardSidebar(s) {
  await keepCommonSettings(s);
  const sets = (await s.get("core.settings")).values.sets;
  await s.run("core.settings.set", { patch: { sets: [...sets,
    { id: "set-files", title: "파일", sections: ["files.tree", "files.bookmarks"], layout: "list" }] }, scope: "common" });
  await s.run("core.settings.link", { place: "card-left", plugin: "terminal", set: "set-files", scope: "common" });
  await s.until("core.sidebars", (value) => value.some((item) => item.sidebar === "terminal:left"),
    "the terminal card sidebar did not appear");
}

/** 기록 파일의 offset 뒤에 쓰인 표면 등록 기록. */
function registrationTimeline(s, offset) {
  const file = join(s.app.configDir, "logs", "performance.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").slice(offset).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).filter((row) => row.event === "surface.registration");
}

/** 창을 검사 시작 상태로 만들고, 창 검사의 터미널이 검사용 셸(check-shell)로 준비될 때까지 기다린 뒤 그 터미널을 반환한다. */
export async function fresh(s, { performanceTrace = TRACE } = {}) {
  const traceFile = join(s.app.configDir, "logs", "performance.ndjson");
  const traceOffset = existsSync(traceFile) ? readFileSync(traceFile, "utf8").length : 0;
  // 창 검사의 터미널은 사용자의 로그인 셸과 무관하게 검사용 셸(check-shell)로 시작한다.
  await prepareFixture(s, { settings: { "terminal.shell": CHECK_SHELL }, performanceTrace });
  let terminal;
  try {
    [terminal] = await terminalReady(s);
  } catch (error) {
    if (!performanceTrace) throw error;
    throw new Error(`${error.message}; registration timeline: ${JSON.stringify(registrationTimeline(s, traceOffset))}`, { cause: error });
  }
  await s.presented();
  try {
    await s.get("terminal.session", terminal.surface);
  } catch (error) {
    throw new Error(`terminal readiness returned stale surface ${terminal.surface}: ${error.message}; ` +
      `current surfaces: ${JSON.stringify(await s.get("core.surfaces"))}`);
  }
  return terminal;
}

/** 보이는 터미널 표면들이 등록되고 테마를 적용할 때까지 기다린 뒤 그 표면들을 반환한다. */
export async function terminalReady(s) {
  await s.until("core.surfaces",
    (all) => all.some((x) => x.visible && x.plugin === "terminal" &&
      x.exposes.includes("status core.surface.document") &&
      x.exposes.includes("status terminal.session") &&
      x.exposes.includes("dom terminal.view")),
    "no visible terminal surface registered its document, session, and view");
  // predicate를 만족하는 알림은 reload가 surface를 교체하기 바로 전의 surface를
  // 설명할 수 있다. id를 반환하기 전에 현재 registry를 읽는다. 오래된 surface id로
  // 진행하지 않는다.
  const active = new Set((await s.get("core.grid")).cards
    .map((card) => card.active)
    .filter(Boolean));
  const terminals = (await s.surfaces("terminal")).filter((x) => active.has(x.surface) &&
    x.exposes.includes("status core.surface.document") &&
    x.exposes.includes("status terminal.session") &&
    x.exposes.includes("dom terminal.view"));
  for (const terminal of terminals) {
    await s.until("core.surface.document", (doc) => doc !== null && doc.readyState === "complete" && doc.themed,
      `terminal ${terminal.surface} did not apply its theme`, { surface: terminal.surface });
  }
  return terminals;
}

