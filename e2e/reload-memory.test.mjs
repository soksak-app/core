import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { APPS, fresh, open } from "./app.mjs";

/**
 * 호스트 프로세스와, 그 창의 앱 페이지를 그리는 WebContent 프로세스(host.window 의 pageProcess)의 RSS(KB). 다른
 * 앱이나 다른 호스트의 WebContent 프로세스는 재지 않는다.
 */
async function memory(session, appName) {
  const { pageProcess } = await session.get("host.window");
  assert.ok(Number.isInteger(pageProcess) && pageProcess > 0, `the app page has no WebContent process: ${pageProcess}`);
  const rows = execFileSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match && { pid: Number(match[1]), rss: Number(match[2]), command: match[3] };
    })
    .filter(Boolean);
  return {
    host: rows.find((row) => row.command.includes(`soksak-${appName}.app/Contents/MacOS/`))?.rss,
    pageProcess,
    webContent: rows.find((row) => row.pid === pageProcess && row.command.includes("com.apple.WebKit.WebContent"))?.rss,
  };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: repeated reload keeps host and WebContent RSS bounded`, async (t) => {
    const session = await open(t, app);
    if (!session) return;
    await fresh(session);
    const before = await memory(session, app.name);
    const samples = [];
    for (let i = 0; i < 40; i++) {
      await session.run("host.window.reload");
      samples.push(await memory(session, app.name));
    }
    const after = samples.at(-1);
    assert.ok(Number.isInteger(before.host) && Number.isInteger(after.host), "host RSS was not measurable");
    assert.ok(after.host - before.host < 64 * 1024, `host RSS grew ${after.host - before.host} KB`);
    assert.ok(Number.isInteger(before.webContent) && Number.isInteger(after.webContent),
      `the page's WebContent RSS was not measurable: ${JSON.stringify({ before, after })}`);
    t.diagnostic(`page process ${before.pageProcess} -> ${after.pageProcess}; WebContent RSS ${samples.map((sample) => sample.webContent).join(",")}`);
    assert.ok(after.webContent - before.webContent < 128 * 1024,
      `WebContent RSS of the page grew ${after.webContent - before.webContent} KB over 40 reloads`);
  });
}
