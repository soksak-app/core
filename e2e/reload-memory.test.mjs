import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

/** RSS (KB) of the process. */
function resident(pid) {
  const text = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
  assert.match(text, /^\d+$/, `RSS of ${pid} was not measurable`);
  return Number(text);
}

/** Physical footprint (bytes) of the process. Resident memory does not shrink while the allocator holds released pages. */
function footprint(pid) {
  const match = execFileSync("footprint", ["-p", String(pid), "-f", "bytes"], { encoding: "utf8" }).match(/Footprint: (\d+) B/);
  assert.ok(match, `footprint of ${pid} was not measurable`);
  return Number(match[1]);
}

/**
 * List of the web documents that the window holds. If a reload leaves the surface document, the document region and the image region of the previous page, the list grows. The document id is
 * assigned anew at every reload, so only the number is compared.
 */
function inventory(window) {
  return {
    webviews: window.webviews.length,
    surfaces: window.surfaces.map((surface) => surface.id).sort(),
    documents: window.documents.length,
    regions: window.regions.length,
  };
}

const RELOADS = 20;

// When the main page reloads, the host opens the new document in a new WebContent process, and the previous process ends together with the previous document
// (docs/operations/private-native-apis.md). A reload in the same process would keep the previous document until memory pressure through the querySelectorAll result cache of WebKit.
// The check judges whether the page process changes at every reload and the previous process ends, and the page footprint, the host memory
// and the documents of the window after the reload.
const PAGE_GROWTH = 64 * 1024 * 1024;

for (const app of Object.values(APPS)) {
  test(`${app.name}: repeated reload keeps the host memory, the page memory and the window documents bounded`, { timeout: 300000 }, async (t) => {
    const session = await open(t, app);
    if (!session) return;
    await fresh(session);
    const { pageProcess: first } = await session.get("host.window");
    assert.ok(Number.isInteger(first) && first > 0, `the app page has no WebContent process: ${first}`);
    await session.request("diagnostics.page.collect", {});
    const footprintBefore = footprint(first);
    const before = inventory(await session.get("host.window"));
    // Process of the host that the check connected. Another app of the same name and sidecars inside the bundle are not measured.
    const host = session.client.endpoint.pid;
    const hostBefore = resident(host);
    const processes = [first];
    for (let i = 0; i < RELOADS; i++) {
      const previous = processes.at(-1);
      await session.run("host.window.reload");
      const { pageProcess } = await session.until("host.window", (window) => window.pageProcess !== previous,
        `reload ${i + 1} kept the page process ${previous}`);
      processes.push(pageProcess);
      await session.request("diagnostics.process.exit", { pid: previous }).catch((error) => {
        throw new Error(`reload ${i + 1} left the previous page process ${previous} running: ${error.message}`);
      });
    }
    const expected = JSON.stringify(before);
    await session.until("host.window", (window) => JSON.stringify(inventory(window)) === expected,
      `the window documents differ from ${expected} after ${RELOADS} reloads`);
    const hostAfter = resident(host);
    await session.request("diagnostics.page.collect", {});
    const footprintAfter = footprint(processes.at(-1));
    t.diagnostic(`documents ${expected}; page processes ${processes.join(" ")}; page footprint ${footprintBefore} -> ` +
      `${footprintAfter} B; host RSS ${hostBefore} -> ${hostAfter} KB`);
    assert.ok(footprintAfter - footprintBefore < PAGE_GROWTH,
      `the page footprint grew ${footprintAfter - footprintBefore} B over ${RELOADS} reloads`);
    assert.ok(hostAfter - hostBefore < 64 * 1024, `host RSS grew ${hostAfter - hostBefore} KB over ${RELOADS} reloads`);
  });
}
