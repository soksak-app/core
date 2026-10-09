// Replaces the application bundle of a running application with a bundle of a newer core release through the
// application update flow (docs/spec/installation.md#application-update) and checks the result.
//
// The check copies a built application bundle, serves a registry index that lists a core release for the host (a copy of
// the bundle with a newer version), starts the copy with a disposable configuration directory, runs `core.app.update`,
// waits until the application that `sok app update` starts is running, and checks that the copied bundle now holds the
// newer version. Every process it started ends before it returns, and it fails when one remains.
// `make app-update-check` runs it.
//
//   node scripts/check-app-update.mjs --host wailsv3|tauriv2 --bundle PATH --registry INDEX
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const NEWER = "99.0.0";
const WAIT_MS = 120_000;

/** The command line options. */
export function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (name === "--host") options.host = value;
    else if (name === "--bundle") options.bundle = value;
    else if (name === "--registry") options.registry = value;
    else throw new Error(`unknown option ${name}`);
  }
  if (options.host !== "wailsv3" && options.host !== "tauriv2") throw new Error("--host must be wailsv3 or tauriv2");
  for (const name of ["bundle", "registry"]) if (!options[name]) throw new Error(`--${name} is required`);
  return options;
}

/** The key of the core release of this machine and host. */
export function releaseKey(host, arch = process.arch) {
  return `darwin-${arch === "arm64" ? "arm64" : "x64"}-${host}`;
}

/** The registry index `base` with the core release `url` and `sha256` for `key`. */
export function withCore(base, key, url, sha256) {
  return { ...base, core: { versions: [{ version: NEWER, releases: { [key]: { url, sha256 } } }] } };
}

const run = (file, args) => execFileSync(file, args, { encoding: "utf8" });

/** Resolves when `ready()` returns a value, re-evaluating it on each change in `folder`; rejects after WAIT_MS. */
function untilChange(folder, ready, what) {
  return new Promise((resolve, reject) => {
    const watcher = watch(folder, () => settle());
    const timer = setTimeout(() => finish(new Error(`${what} did not happen in ${WAIT_MS / 1000} s`)), WAIT_MS);
    const finish = (error, value) => {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve(value);
    };
    const settle = () => {
      let value;
      try {
        value = ready();
      } catch (error) {
        finish(error);
        return;
      }
      if (value) finish(null, value);
    };
    settle();
  });
}

/** The endpoint of the configuration directory, or null while it is not written. */
function endpointOf(config) {
  try {
    return JSON.parse(readFileSync(join(config, "endpoint.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

/** Ends the process and resolves when it has ended; reports a process that stays. */
async function end(pid) {
  if (!alive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 30_000;
  // Node reports the end only of a process that it started as a child; the application that `sok app update` starts is
  // not one, and no other source reports its end, so its existence is read every 100 ms until the deadline.
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`process ${pid} still runs 30 s after SIGTERM`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "soksak-app-update-check-")));
  const pids = new Set();
  try {
    const running = join(work, "run", "soksak.app");
    const newer = join(work, "new", "soksak.app");
    const config = join(work, "config");
    mkdirSync(join(work, "run"));
    mkdirSync(join(work, "new"));
    mkdirSync(join(config, "plugins"), { recursive: true });
    run("ditto", [options.bundle, running]);
    run("ditto", [options.bundle, newer]);
    run("plutil", ["-replace", "CFBundleShortVersionString", "-string", NEWER, join(newer, "Contents", "Info.plist")]);
    run("codesign", ["--force", "--deep", "--sign", "-", newer]);
    const zip = join(work, `soksak-${NEWER}.zip`);
    run("ditto", ["-c", "-k", "--keepParent", newer, zip]);
    const sha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
    const index = withCore(JSON.parse(readFileSync(options.registry, "utf8")), releaseKey(options.host), pathToFileURL(zip).href, sha256);
    const indexPath = join(work, "index.json");
    writeFileSync(indexPath, JSON.stringify(index));
    // An empty installation is not a first run, so the application installs no starter pack.
    writeFileSync(join(config, "plugins", "installed.json"), JSON.stringify({ format: 2, plugins: {}, sidecars: {} }));
    const sok = (...args) => run(join(running, "Contents", "MacOS", "sok"), [...args, "--config-dir", config]);
    sok("registry", "use", indexPath);

    const log = createWriteStream(join(work, "application.out"));
    await new Promise((resolve) => log.once("open", resolve));
    const child = spawn(join(running, "Contents", "MacOS", `soksak-${options.host}`), ["--config-dir", config], {
      stdio: ["ignore", log, log], detached: true,
    });
    child.unref();
    pids.add(child.pid);
    const first = await untilChange(config, () => {
      const endpoint = endpointOf(config);
      return endpoint?.pid === child.pid ? endpoint : null;
    }, "the application endpoint");
    console.log(`started ${first.pid}`);

    // `status --watch` prints only the changes, so a wait starts the watch first and reads the current value after it:
    // the read either satisfies the predicate or the watch reports the change that does.
    const sokPath = join(running, "Contents", "MacOS", "sok");
    const statusUntil = (name, predicate, what) => new Promise((resolve, reject) => {
      const watching = spawn(sokPath, ["status", name, "--watch", "--config-dir", config]);
      const finish = (error) => {
        clearTimeout(timer);
        watching.kill();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error(`${what} did not happen in ${WAIT_MS / 1000} s`)), WAIT_MS);
      let text = "";
      watching.stdout.on("data", (chunk) => {
        // A change is printed as one JSON line.
        text += chunk;
        const lines = text.split("\n");
        text = lines.pop();
        try {
          if (lines.some((line) => line.trim() !== "" && predicate(JSON.parse(line)))) finish();
        } catch (error) {
          finish(error);
        }
      });
      watching.once("error", finish);
      const read = spawn(sokPath, ["status", name, "--config-dir", config]);
      let current = "";
      read.stdout.on("data", (chunk) => { current += chunk; });
      read.once("close", () => {
        try {
          if (current !== "" && predicate(JSON.parse(current))) finish();
        } catch (error) {
          finish(error);
        }
      });
    });
    // The status core.app belongs to the page, which answers once its window is ready; the window list is the host's.
    await statusUntil("host.windows", (windows) => windows.length > 0 && windows.every((window) => window.ready), "the window ready");
    // The window reads the candidate when it starts.
    await statusUntil("core.app", (app) => app.available?.version === NEWER, "core.app listing the newer core release");
    console.log(`core.app lists ${NEWER}`);

    // The command quits the application, so its reply never arrives; the new application proves that it ran.
    const update = spawn(join(running, "Contents", "MacOS", "sok"), ["core.app.update", "--config-dir", config], { stdio: "ignore" });
    update.once("error", (error) => { throw error; });
    const second = await untilChange(config, () => {
      const endpoint = endpointOf(config);
      return endpoint && endpoint.pid !== first.pid && alive(endpoint.pid) ? endpoint : null;
    }, "the application that the update starts");
    pids.add(second.pid);
    console.log(`restarted ${second.pid}`);

    const version = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(running, "Contents", "Info.plist")]).trim();
    if (version !== NEWER) throw new Error(`the bundle holds version ${version}, not ${NEWER}`);
    if (existsSync(`${running}.previous`)) throw new Error(`${running}.previous stayed after the update`);
    if (alive(first.pid)) throw new Error(`the earlier application ${first.pid} still runs`);
    // The restarted application lists the same candidate once its window is ready.
    await statusUntil("host.windows", (windows) => windows.length > 0 && windows.every((window) => window.ready), "the restarted window ready");
    await statusUntil("core.app", (app) => app.available?.version === NEWER, "the restarted application listing the newer core release");
    console.log(`the bundle holds ${version}`);
  } finally {
    const failures = [];
    for (const pid of pids) {
      try {
        await end(pid);
      } catch (error) {
        failures.push(error);
      }
    }
    const endpoint = endpointOf(join(work, "config"));
    if (endpoint && alive(endpoint.pid)) {
      try {
        await end(endpoint.pid);
      } catch (error) {
        failures.push(error);
      }
    }
    rmSync(work, { recursive: true, force: true });
    if (failures.length) throw new Error(failures.map((error) => error.message).join("; "));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
