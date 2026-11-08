import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { declaredChains } from "../chains.mjs";

test("the catalog must declare exactly the chains that this check and the input check perform", () => {
  const folder = mkdtempSync(join(tmpdir(), "soksak-chains-test-"));
  try {
    const write = (chains) => {
      const path = join(folder, "events.json");
      writeFileSync(path, JSON.stringify({ chains }));
      return path;
    };
    const names = ["input", "plugin", "project", "settings", "update", "window"];
    const six = Object.fromEntries(names.map((name) => [name, [`page.${name}`, "workbench.call", "host.binding.call"]]));
    assert.deepEqual(declaredChains(write(six)), six);
    assert.throws(() => declaredChains(write({ plugin: six.plugin })),
      /the catalog declares the chains plugin, and the checks perform input \(e2e\/input-records\.test\.mjs\), plugin, project, settings, update and window/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
