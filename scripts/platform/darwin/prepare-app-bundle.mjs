// Builds a macOS application bundle beside the bundle and installs it with one rename, only when no process is executing from that
// bundle (docs/spec/hosts.md). Preparation creates the staging bundle `<folder>/.staging/<name>.app` anew; the build writes and signs
// it; installation verifies its signature and exchanges it with the bundle.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
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
 * Creates the staging bundle of `bundle` for `application` anew, with the Info.plist and the icon of the application, and returns its
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
  copyFileSync(join(ROOT, "apps", application, "platform", "darwin", "AppIcon.icns"), join(contents, "Resources", "AppIcon.icns"));
  return staging;
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
    options: { bundle: { type: "string" }, app: { type: "string" }, install: { type: "boolean" }, swap: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const usage = "usage: prepare-app-bundle.mjs --bundle PATH --app gpuikit|mygo|tauriv2|wailsv3 | --install --bundle PATH --swap SOK_SWAP_BUNDLE";
  if (positionals.length > 0 || !values.bundle) throw new Error(usage);
  if (values.install) {
    if (values.app !== undefined || !values.swap) throw new Error(usage);
    installBundle(values.bundle, { swap: values.swap });
    return;
  }
  if (!values.app || values.swap !== undefined) throw new Error(usage);
  prepareBundle(values.bundle, values.app);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
