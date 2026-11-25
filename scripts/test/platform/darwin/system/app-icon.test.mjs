// Prepares a disposable bundle with the actool of this system and reads the icon that the preparation wrote (docs/spec/hosts.md#frontend-and-executables).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SCRIPT = join(ROOT, "scripts", "platform", "darwin", "prepare-app-bundle.mjs");

/** Runs `command` and returns its standard output, failing with its standard error. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${command} did not start: ${result.error?.message}`);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  return result.stdout;
}

test("each application bundle holds the compiled icon in the light, dark and tinted appearances", { timeout: 240000 }, (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-app-icon-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const actool = run("xcrun", ["--find", "actool"]).trim();
  for (const application of ["gpuikit", "mygo", "tauriv2", "wailsv3"]) {
    const bundle = join(temporary, `sok-${application}.app`);
    run(process.execPath, [SCRIPT, "--bundle", bundle, "--app", application, "--actool", actool]);
    const contents = join(temporary, ".staging", `sok-${application}.app`, "Contents");
    assert.ok(existsSync(join(contents, "Resources", "AppIcon.icns")), `the ${application} preparation wrote no AppIcon.icns for earlier systems`);
    const catalog = join(contents, "Resources", "Assets.car");
    assert.ok(existsSync(catalog), `the ${application} preparation wrote no Assets.car`);
    assert.equal(run("plutil", ["-extract", "CFBundleIconName", "raw", join(contents, "Info.plist")]).trim(), "AppIcon");
    const renditions = JSON.parse(run("xcrun", ["assetutil", "--info", catalog])).slice(1);
    const appearances = renditions
      .filter((rendition) => rendition.AssetType === "IconImageStack" && rendition.Name === "AppIcon")
      .map((rendition) => rendition.Appearance)
      .sort();
    assert.deepEqual(appearances, ["ISAppearanceTintable", "NSAppearanceNameAqua", "NSAppearanceNameDarkAqua"], `the ${application} icon`);
  }
});
