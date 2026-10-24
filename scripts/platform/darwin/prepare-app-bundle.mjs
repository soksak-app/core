// Rebuilds a macOS application bundle only when no process is executing from that bundle.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const APPLICATIONS = new Set(["tauriv2", "wailsv3"]);

/** Parses the process table format used by `ps -axww -o pid=,command=`. */
function parseProcessTable(text) {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) throw new Error(`process row ${JSON.stringify(line)} has no PID and command`);
    return { pid: Number(match[1]), command: match[2] };
  });
}

/** Returns bundle executable prefixes in the argument form and the absolute form. */
function executablePrefixes(bundle) {
  const absoluteBundle = resolve(bundle);
  const values = new Set([absoluteBundle]);
  if (!isAbsolute(bundle)) values.add(normalize(bundle));
  return [...values].map((value) => `${value}/Contents/MacOS/`);
}

/** A command is attributed only when its argv[0] starts with the exact target bundle executable directory. */
function processUsesBundle(command, prefixes) {
  const line = command.replace(/\/{2,}/g, "/");
  return prefixes.some((prefix) => line.startsWith(prefix) && line.slice(prefix.length).split(/[\s"']/)[0] !== "");
}

function runningBundleProcesses(bundle) {
  const result = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`ps failed while checking bundle ${resolve(bundle)}: ${result.error?.message ?? result.stderr.trim()}`);
  }
  const prefixes = executablePrefixes(bundle);
  return parseProcessTable(result.stdout).filter(({ pid, command }) => pid !== process.pid && processUsesBundle(command, prefixes));
}

function prepareBundle(bundle, application) {
  if (process.platform !== "darwin") throw new Error(`macOS bundle preparation is not implemented on ${process.platform}`);
  if (!APPLICATIONS.has(application)) throw new Error(`unknown application ${JSON.stringify(application)}`);
  const absoluteBundle = resolve(bundle);
  const active = runningBundleProcesses(bundle);
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
    throw new Error("usage: prepare-app-bundle.mjs --bundle PATH --app tauriv2|wailsv3");
  }
  prepareBundle(values.bundle, values.app);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
