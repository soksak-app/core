import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { enginesErrors } from "../engines-check.js";

const VERSION = "0.0.3";

test("a plugin declares the core release of its plugin API", () => {
  assert.deepEqual(enginesErrors({ engines: { soksak: `^${VERSION}` } }, VERSION), []);
  // * 는 모든 core version 에서 설치된다는 선언이다.
  assert.deepEqual(enginesErrors({ engines: { soksak: "*" } }, VERSION), []);
  assert.deepEqual(enginesErrors({ engines: { soksak: "^0.0.2" } }, VERSION),
    [`package.json: engines.soksak ^0.0.2 must be * or ^${VERSION}, the @soksak/plugin-api version`]);
  assert.deepEqual(enginesErrors({ engines: {} }, VERSION),
    [`package.json: engines.soksak undefined must be * or ^${VERSION}, the @soksak/plugin-api version`]);
  assert.deepEqual(enginesErrors({}, VERSION),
    [`package.json: engines.soksak undefined must be * or ^${VERSION}, the @soksak/plugin-api version`]);
});

test("the command checks the package.json of the given plugin repository", async () => {
  const { execFileSync } = await import("node:child_process");
  const { version } = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const repository = mkdtempSync(join(tmpdir(), "soksak-engines-"));
  try {
    const command = new URL("../engines-check.js", import.meta.url).pathname;
    writeFileSync(join(repository, "package.json"), JSON.stringify({ engines: { soksak: `^${version}` } }));
    assert.equal(execFileSync(process.execPath, [command, repository], { encoding: "utf8" }),
      `Engines check passed: engines.soksak is ^${version}\n`);
    // 성공 줄은 검사한 범위를 그대로 적는다.
    writeFileSync(join(repository, "package.json"), JSON.stringify({ engines: { soksak: "*" } }));
    assert.equal(execFileSync(process.execPath, [command, repository], { encoding: "utf8" }),
      "Engines check passed: engines.soksak is *\n");
    writeFileSync(join(repository, "package.json"), JSON.stringify({ engines: { soksak: "^0.0.1" } }));
    assert.throws(() => execFileSync(process.execPath, [command, repository], { encoding: "utf8", stdio: "pipe" }),
      (error) => error.status === 1 && error.stderr === `package.json: engines.soksak ^0.0.1 must be * or ^${version}, the @soksak/plugin-api version\n`);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
