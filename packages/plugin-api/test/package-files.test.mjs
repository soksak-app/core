import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageRoot = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));

test("the published package includes each plugin contract file", () => {
  for (const file of ["contract/view-wire.json", "contract/view-bridge.json", "contract/interactive.json", "contract/declared-ui-snapshot.json", "contract/expose.json", "contract/command-registration.json", "contract/view-commands.json"]) {
    assert.ok(manifest.files.includes(file), `${file} is missing from package.json files`);
    assert.doesNotThrow(() => readFileSync(new URL(file, packageRoot), "utf8"), file);
  }
});
