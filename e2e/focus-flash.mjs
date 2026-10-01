// V5-114: 터미널 카드 선택 시 브라우저 주소 표시줄로 포커스가 도약하는지를 이벤트 순서로 잰다.
// 준비: 주소창을 activeElement 로 만들고 터미널 A에 네이티브 포커스를 둔 뒤, 터미널 A 영역을
// 실제 클릭(input.pointer)한다. 진단 로그의 페이지 focus in/out 줄로 도약(재발화)을 증명한다.
// 이 검사는 실행 중인 체크 앱에 연결한다(앱을 띄우지 않는다).
import { existsSync } from "node:fs";
import { connect } from "@soksak/client";

const configDir = process.env.TMPDIR + "soksak-check-tauriv2";
if (!existsSync(configDir + "/endpoint.json")) {
  console.log("SKIP focus-flash: the check application is not running");
  process.exit(0);
}
const client = await connect({ configDir });

// 진단 로그 스트림(페이지가 report 한 줄이 이 이벤트로 온다).
const lines = [];
client.on("diagnostics.log", (params) => {
  if (params?.window === "main") lines.push(params.line);
});
await client.request("diagnostics.transcript", { window: "main", on: true });

async function until(predicate, what, limit = 10_000) {
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`${what} did not happen within ${limit}ms`);
}
const status = async (name, surface) =>
  surface === undefined
    ? await client.request("status.get", { window: "main", name })
    : await client.request("status.get", { window: "main", name, surface });

// 준비: 터미널 카드 1 + 브라우저 카드 1.
await client.request("diagnostics.fixture", { window: "main", settings: {} });
const grid = async () => await status("core.grid");
let g = await grid();
const terminalTab = g.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
if (!terminalTab) throw new Error("fixture has no terminal tab");
await client.request("command.run", { window: "main", name: "core.tab.select", params: { tab: terminalTab.id } });
await until(async () => (await status("core.surfaces")).some((item) => item.visible && item.plugin === "terminal"),
  "terminal surface visible");
await client.request("command.run", {
  window: "main", name: "core.card.split",
  params: { card: g.cards.find((card) => card.tabs.some((tab) => tab.id === terminalTab.id)).id, side: "right", plugin: "browser" },
});
await until(async () => (await status("core.surfaces")).some((item) => item.visible && item.plugin === "browser"),
  "browser surface visible");
const browserTab = (await grid()).cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "browser");
const terminalSurface = terminalTab.id;

// 1) 주소창을 쓰고 엔터친 뒤의 상태: 주소창이 activeElement 다.
await client.request("command.run", { window: "main", name: "core.tab.select", params: { tab: browserTab.id } });
await client.request("command.run", { window: "main", name: "browser.address.select", params: {}, surface: browserTab.id });

// 2) 터미널 A에 네이티브 포커스를 둔다(포커스 명령 경로).
await client.request("command.run", { window: "main", name: "terminal.focus", params: {}, surface: terminalSurface });
await until(async () => (await status("terminal.cursor", terminalSurface)).focused === true, "terminal A focused");

// 3) 터미널 A 영역을 실제 클릭한다 — 카드 선택. 도약이 일어나는 경로다.
const window = await status("host.window");
const region = window.regions.find((item) => item.surface === terminalSurface && item.name === "view");
const x = region.frame.x + region.frame.width / 2;
const y = region.frame.y + region.frame.height / 2;
lines.length = 0;
await client.request("input.pointer", { window: "main", x, y, phase: "down" });
await client.request("input.pointer", { window: "main", x, y, phase: "up" });

// 4) 흐름이 끝나기를 기다린다: 응답자가 터미널 표면에 안착한다.
await until(async () => {
  const now = await status("host.window");
  return now.responder?.surface === terminalSurface
    || (await status("terminal.cursor", terminalSurface)).focused === true;
}, "the responder returned to the terminal");
// 안착 여유: 비동기 응답자 반환과 마지막 초점 보고가 흐르기를 조건으로 기다린다.
await until(async () => {
  const now = await status("host.window");
  return now.responder?.surface === terminalSurface
    || (await status("terminal.cursor", terminalSurface)).focused === true;
}, "the responder stayed on the terminal");

// 5) 판정: 클릭 창 동안 페이지가 키보드 포커스를 얻으며 주소창에 focus in 이 재발화되었는가.
const addressFocusIns = lines.filter((line) => /^focus in .*(browser.address|INPUT)/.test(line));
console.log(`INFO captured ${lines.length} diagnostics lines`);
for (const line of lines.slice(0, 14)) console.log(`LINE ${line}`);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} focus-flash ${what}`);
  if (!ok) failures++;
};
check(addressFocusIns.length === 0,
  `no address-bar focus refire during the terminal click (refires: ${addressFocusIns.length})`);
check(lines.length > 0, "the observation instruments produced lines");
await client.request("diagnostics.transcript", { window: "main", on: false });
client.close();
console.log(failures === 0 ? "PASS focus-flash" : `FAIL focus-flash (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
