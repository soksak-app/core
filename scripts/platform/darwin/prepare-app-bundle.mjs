// Builds a macOS application bundle beside the bundle and installs it with one rename, only when no process is executing from that
// bundle (docs/spec/hosts.md). Preparation creates the staging bundle `<folder>/.staging/<name>.app` anew; the build writes and signs
// it; installation verifies its signature and exchanges it with the bundle.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { processes } from "@soksak/window-check/platform/platform.mjs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const APPLICATIONS = new Set(["gpuikit", "mygo", "tauriv2", "wailsv3"]);

/**
 * The processes that execute from `bundle`: those whose executable, the absolute path that the system reports for the executing file
 * (docs/spec/verification.md#process-table), lies in the executable directory of the real path of the bundle. The system resolves a
 * relative or linked launch path, so a process of another checkout that runs the same relative path is not this bundle.
 */
function runningBundleProcesses(bundle) {
  const absolute = resolve(bundle);
  const directory = `${existsSync(absolute) ? realpathSync(absolute) : absolute}/Contents/MacOS/`;
  return processes({ executable: true }).filter(({ pid, executable }) =>
    pid !== process.pid && executable !== null && executable.startsWith(directory) && executable.length > directory.length);
}

/** The staging bundle of `bundle`: `<folder>/.staging/<name>.app`, on the file system of the bundle, so one rename installs it. */
export function stagingBundle(bundle) {
  const absoluteBundle = resolve(bundle);
  return join(dirname(absoluteBundle), ".staging", basename(absoluteBundle));
}

/** Throws with the PID of each process that executes from `bundle` and the bundle path. */
function refuseRunning(bundle) {
  const active = runningBundleProcesses(bundle);
  if (active.length > 0) {
    const owners = active.map(({ pid }) => `PID ${pid}`).join(", ");
    throw new Error(`refusing to replace bundle ${resolve(bundle)}: process ${owners} is executing from its Contents/MacOS directory`);
  }
}

/**
 * Creates the staging bundle of `bundle` for `application` anew, with the Info.plist of the application, and returns its
 * path, unless a process executes from `bundle`. The bundle itself does not change. `platform` is the system that the bundle is
 * prepared on; a test passes it.
 */
export function prepareBundle(bundle, application, { platform = process.platform } = {}) {
  if (platform !== "darwin") throw new Error(`macOS bundle preparation is not implemented on ${platform}`);
  if (!APPLICATIONS.has(application)) throw new Error(`unknown application ${JSON.stringify(application)}`);
  refuseRunning(bundle);
  const staging = stagingBundle(bundle);
  rmSync(staging, { recursive: true, force: true });
  const contents = join(staging, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  copyFileSync(join(ROOT, "apps", application, "platform", "darwin", "Info.plist"), join(contents, "Info.plist"));
  return staging;
}

/**
 * Compiles the Icon Composer source `apps/<application>/platform/darwin/AppIcon.icon` with the `actool` at `actool` into the Resources
 * of the staging bundle `staging`: `Assets.car`, which macOS 26 and later read through CFBundleIconName, and `AppIcon.icns` for earlier
 * systems, for the minimum system version that the Info.plist of the bundle declares (docs/spec/hosts.md#frontend-and-executables).
 * Throws with the output of actool when it fails or does not write both files.
 */
export function compileAppIcon(staging, application, actool) {
  if (typeof actool !== "string" || actool === "") throw new Error("compiling the app icon needs the path of actool");
  const contents = join(staging, "Contents");
  const minimum = spawnSync("plutil", ["-extract", "LSMinimumSystemVersion", "raw", join(contents, "Info.plist")], { encoding: "utf8" });
  if (minimum.error || minimum.status !== 0) {
    throw new Error(`reading LSMinimumSystemVersion of ${join(contents, "Info.plist")} failed: ${minimum.error?.message ?? minimum.stderr.trim()}`);
  }
  const resources = join(contents, "Resources");
  const partial = mkdtempSync(join(tmpdir(), "soksak-app-icon-"));
  try {
    const source = join(ROOT, "apps", application, "platform", "darwin", "AppIcon.icon");
    const compiled = spawnSync(actool, [source, "--compile", resources, "--app-icon", "AppIcon", "--platform", "macosx", "--target-device", "mac",
      "--minimum-deployment-target", minimum.stdout.trim(), "--output-partial-info-plist", join(partial, "Info.plist"),
      "--errors", "--warnings", "--output-format", "human-readable-text"],
      // actool runs with the developer folder of its own Xcode, which may differ from the selected one.
      { encoding: "utf8", env: { ...process.env, DEVELOPER_DIR: resolve(dirname(actool), "..", "..") } });
    const output = `${compiled.stdout ?? ""}${compiled.stderr ?? ""}`.trim();
    if (compiled.error || compiled.status !== 0 || /com\.apple\.actool\.(errors|warnings)/.test(output)
      || !existsSync(join(resources, "Assets.car")) || !existsSync(join(resources, "AppIcon.icns"))) {
      throw new Error(`compiling ${source} with ${actool} failed: ${compiled.error?.message ?? output}`);
    }
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

/**
 * Installs the signed staging bundle of `bundle` at `bundle` with one rename through the tool `swap` (native/darwin/build/sok-swap-bundle)
 * and removes the earlier bundle, which the exchange left at the staging path, unless a process executes from `bundle` or the staging
 * bundle does not verify. `platform` is that of prepareBundle.
 */
export function installBundle(bundle, { platform = process.platform, swap } = {}) {
  if (platform !== "darwin") throw new Error(`macOS bundle installation is not implemented on ${platform}`);
  if (typeof swap !== "string" || swap === "") throw new Error("bundle installation needs the path of sok-swap-bundle");
  const absoluteBundle = resolve(bundle);
  const staging = stagingBundle(bundle);
  refuseRunning(bundle);
  const verified = spawnSync("codesign", ["--verify", "--deep", "--strict", staging], { encoding: "utf8" });
  if (verified.error || verified.status !== 0) {
    throw new Error(`refusing to install ${staging} at ${absoluteBundle}: the staging bundle does not verify: ${verified.error?.message ?? verified.stderr.trim()}`);
  }
  const swapped = spawnSync(swap, [staging, absoluteBundle], { encoding: "utf8" });
  if (swapped.error || swapped.status !== 0) {
    throw new Error(`installing ${staging} at ${absoluteBundle} failed: ${swapped.error?.message ?? swapped.stderr.trim()}`);
  }
  rmSync(staging, { recursive: true, force: true });
}

function main(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { bundle: { type: "string" }, app: { type: "string" }, install: { type: "boolean" }, swap: { type: "string" }, actool: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const usage = "usage: prepare-app-bundle.mjs --bundle PATH --app gpuikit|mygo|tauriv2|wailsv3 --actool ACTOOL | --install --bundle PATH --swap SOK_SWAP_BUNDLE";
  if (positionals.length > 0 || !values.bundle) throw new Error(usage);
  if (values.install) {
    if (values.app !== undefined || values.actool !== undefined || !values.swap) throw new Error(usage);
    installBundle(values.bundle, { swap: values.swap });
    return;
  }
  if (!values.app || !values.actool || values.swap !== undefined) throw new Error(usage);
  compileAppIcon(prepareBundle(values.bundle, values.app), values.app, values.actool);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
