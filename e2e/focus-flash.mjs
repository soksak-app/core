// V5-114: 터미널 카드 전환 시 브라우저 주소 표시줄로 포커스가 도약하는지 관측한다.
// 명령(core.card.focus)과 실제 클릭(input.pointer) 두 경로를 각각 재고, 브라우저 주소창의
// focused 상태 변화와 성능 트레이스의 focus 줄로 재현을 증명한다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "@soksak/client";

const configDir = process.env.TMPDIR + "soksak-check-tauriv2";
const client = await connect({ configDir });
const trace = () => readFileSync(configDir + "/logs/performance.ndjson", "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

async function until(predicate, what, limit = 10_000) {
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`${what} did not happen within ${limit}ms`);
}

// 준비: 터미널 2 + 브라우저 1 배치. fixture 가 성능 트레이스를 기본값(끔)으로 되돌리므로
// fixture 뒤에 다시 켠다 — 이 관측의 줄은 트레이스 타임라인에 남아야 한다.
await client.request("diagnostics.fixture", { window: "main", settings: {} });
await client.request("command.run", { window: "main", name: "core.settings.change", params: { key: "diagnostics.performance", value: true, scope: "common" } });
const grid = async () => await client.request("status.get", { window: "main", name: "core.grid" });
let g = await grid();
const terminalTab = g.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
if (!terminalTab) throw new Error("fixture has no terminal tab");
await client.request("command.run", { window: "main", name: "core.tab.select", params: { tab: terminalTab.id } });
await until(async () => (await client.request("status.get", { window: "main", name: "core.surfaces" }))
  .some((item) => item.visible && item.plugin === "terminal"), "terminal surface visible");
await client.request("command.run", { window: "main", name: "core.card.split", params: { card: g.cards.find((card) => card.tabs.some((tab) => tab.id === terminalTab.id)).id, axis: "x", plugin: "browser" } });
await until(async () => (await client.request("status.get", { window: "main", name: "core.surfaces" }))
  .some((item) => item.visible && item.plugin === "browser"), "browser surface visible");
g = await grid();
const terminals = g.cards.flatMap((card) => card.tabs).filter((tab) => tab.plugin === "terminal");
const browserTab = g.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "browser");
console.log(`INFO terminals=${terminals.length} browser=${browserTab ? browserTab.id : "none"}`);

// 브라우저 주소창에 포커스를 둬 둔다(사용자가 주소를 쓰고 엔터친 뒤의 상태).
await client.request("command.run", { window: "main", name: "core.tab.select", params: { tab: browserTab.id } });
await client.request("command.run", { window: "main", name: "command.run", params: {} }).catch(() => {});
await client.request("status.get", { window: "main", name: "browser.address.text", surface: browserTab.id });
// 주소창에 포커스: browser.address.select 명령으로.
await client.request("command.run", { window: "main", name: "browser.address.select", params: {}, surface: browserTab.id });
await until(async () => (await client.request("status.get", { window: "main", name: "browser.address.text", surface: browserTab.id })).focused === true,
  "address bar focused");

// ── 경로 1: 명령으로 터미널 카드 선택.
const traceBefore1 = trace().length;
await client.request("command.run", { window: "main", name: "core.card.focus", params: { card: g.cards.find((card) => card.tabs.some((tab) => tab.plugin === "terminal")).id } });
await new Promise((resolve) => setImmediate(resolve));
const address1 = await client.request("status.get", { window: "main", name: "browser.address.text", surface: browserTab.id });
const focusLines1 = trace().slice(traceBefore1).filter((line) => line.event === "focus");
console.log(`PATH command: address focused=${address1.focused} focusTrace=${focusLines1.length}`);
console.log(`RESULT command-flash ${address1.focused === true ? "REPRODUCED" : "absent"}`);

// ── 경로 2: 실제 클릭(input.pointer)으로 터미널 카드의 다른 터미널 선택.
const window = await client.request("status.get", { window: "main", name: "host.window" });
const region = window.regions.find((item) => item.surface === terminals[0].id && item.name === "view");
const traceBefore2 = trace().length;
await client.request("input.pointer", { window: "main", x: region.frame.x + region.frame.width / 2, y: region.frame.y + region.frame.height / 2, phase: "down" });
await client.request("input.pointer", { window: "main", x: region.frame.x + region.frame.width / 2, y: region.frame.y + region.frame.height / 2, phase: "up" });
await new Promise((resolve) => setImmediate(resolve));
const address2 = await client.request("status.get", { window: "main", name: "browser.address.text", surface: browserTab.id });
const focusLines2 = trace().slice(traceBefore2).filter((line) => line.event === "focus");
console.log(`PATH click: address focused=${address2.focused} focusTrace=${focusLines2.length}`);
console.log(`RESULT click-flash ${address2.focused === true ? "REPRODUCED" : "absent"}`);
for (const line of focusLines2.slice(0, 6)) console.log(`TRACE ${JSON.stringify(line)}`);

client.close();
