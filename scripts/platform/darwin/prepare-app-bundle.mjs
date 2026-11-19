// Rebuilds a macOS application bundle only when no process is executing from that bundle.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const APPLICATIONS = new Set(["gpuikit", "mygo", "tauriv2", "wailsv3"]);

/** Parses the process table format used by `ps -axww -o pid=,command=`. */
function parseProcessTable(text) {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) throw new Error(`process row ${JSON.stringify(line)} has no PID and command`);
    return { pid: Number(match[1]), command: match[2] };
  });
}

/** The directory of the executables of `bundle`, absolute. */
const executableDirectory = (bundle) => `${resolve(bundle)}/Contents/MacOS/`;

/**
 * The executable path of a command that names a file of a `Contents/MacOS/` directory: the command up to the first space or quote after
 * that directory, so a bundle path with spaces stays whole, or null for another command.
 */
function executableOf(command) {
  const line = command.replace(/\/{2,}/g, "/");
  const at = line.indexOf("/Contents/MacOS/");
  if (at < 0) return null;
  const start = at + "/Contents/MacOS/".length;
  const file = line.slice(start).split(/[\s"']/)[0];
  return file === "" ? null : line.slice(0, start) + file;
}

/**
 * The working directory of the process `pid`, from `lsof -a -p <pid> -d cwd -Fn`, or null when the process ended after the process
 * table was read. A relative executable path names a file of that directory, so another checkout that runs the same relative path is
 * not this bundle.
 */
function workingDirectory(pid, run) {
  const result = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  if (result.error) throw new Error(`lsof failed while reading the working directory of PID ${pid}: ${result.error.message}`);
  const name = result.stdout.split("\n").find((line) => line.startsWith("n"));
  // lsof ends with status 1 and lists nothing for a process that no longer exists.
  if (result.status === 1 && result.stdout.trim() === "") return null;
  if (result.status !== 0 || !name) {
    throw new Error(`lsof listed no working directory of PID ${pid}: status ${result.status}, ${JSON.stringify(result.stdout + result.stderr)}`);
  }
  return name.slice(1);
}

/**
 * The processes that execute from `bundle`. `run` has the signature of spawnSync and reads the process table and the working directory
 * of a process with a relative executable path; a test passes its own.
 */
function runningBundleProcesses(bundle, run = spawnSync) {
  // The output has no bound, because the commands of other processes can exceed any fixed buffer, and every row is read to find
  // a process of the bundle.
  const result = run("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: Infinity });
  if (result.error || result.status !== 0) {
    throw new Error(`ps failed while checking bundle ${resolve(bundle)}: ${result.error?.message ?? result.stderr.trim()}`);
  }
  const directory = executableDirectory(bundle);
  // An executable path is attributed only when it lies in the exact target bundle executable directory, a relative one resolved
  // against the working directory of its process.
  const inBundle = (path) => path.startsWith(directory) && path.length > directory.length;
  return parseProcessTable(result.stdout).filter(({ pid, command }) => {
    if (pid === process.pid) return false;
    const executable = executableOf(command);
    if (executable === null) return false;
    if (isAbsolute(executable)) return inBundle(executable);
    if (!executable.includes(`${basename(resolve(bundle))}/Contents/MacOS/`)) return false;
    const cwd = workingDirectory(pid, run);
    return cwd !== null && inBundle(resolve(cwd, executable));
  });
}

/**
 * Recreates the Contents of `bundle` for `application` unless a process executes from it. `platform` is the system that the bundle is
 * prepared on and `run` reads its process table (runningBundleProcesses); a test passes both.
 */
export function prepareBundle(bundle, application, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== "darwin") throw new Error(`macOS bundle preparation is not implemented on ${platform}`);
  if (!APPLICATIONS.has(application)) throw new Error(`unknown application ${JSON.stringify(application)}`);
  const absoluteBundle = resolve(bundle);
  const active = runningBundleProcesses(bundle, run);
  if (active.length > 0) {
    const owners = active.map(({ pid }) => `PID ${pid}`).join(", ");
    throw new Error(`refusing to replace bundle ${absoluteBundle}: process ${owners} is executing from its Contents/MacOS directory`);
  }

  const contents = join(absoluteBundle, "Contents");
  rmSync(contents, { recursive: true, force: true });
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  copyFileSync(join(ROOT, "apps", application, "platform", "darwin", "Info.plist"), join(contents, "Info.plist"));
  copyFileSync(join(ROOT, "apps", application, "platform", "darwin", "AppIcon.icns"), join(contents, "Resources", "AppIcon.icns"));
}

function main(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { bundle: { type: "string" }, app: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0 || !values.bundle || !values.app) {
    throw new Error("usage: prepare-app-bundle.mjs --bundle PATH --app gpuikit|tauriv2|wailsv3");
  }
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
