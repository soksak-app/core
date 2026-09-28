import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { APPS, fresh, open } from "./app.mjs";

function memory(appName) {
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
    webContent: rows.filter((row) => row.command.includes("com.apple.WebKit.WebContent")).map((row) => row.rss),
  };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: repeated reload keeps host and WebContent RSS bounded`, async (t) => {
    const session = await open(t, app);
    if (!session) return;
    await fresh(session);
    const before = memory(app.name);
    const samples = [];
    for (let i = 0; i < 40; i++) {
      await session.run("host.window.reload");
      samples.push(memory(app.name));
    }
    const after = samples.at(-1);
    assert.ok(Number.isInteger(before.host) && Number.isInteger(after.host), "host RSS was not measurable");
    assert.ok(after.host - before.host < 64 * 1024, `host RSS grew ${after.host - before.host} KB`);
    assert.ok(before.webContent.length && after.webContent.length, "WebContent RSS was not measurable");
    const beforeWeb = Math.max(...before.webContent);
    const afterWeb = Math.max(...after.webContent);
    assert.ok(afterWeb - beforeWeb < 128 * 1024,
      `WebContent RSS grew ${afterWeb - beforeWeb} KB over 40 reloads`);
  });
}
