// The readiness of an application for the agent layout runs (F959-4). The application is ready when its endpoint file exists and its
// window list reports the window ready, which the host declares in the `ready` member of each entry of `host.windows`. Both waits are
// events: a file system event for the endpoint file, and the status watch of `host.windows`, which the endpoint pushes on each change.
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";

/** Resolves when the endpoint file of the configuration folder exists. The watch is set before the check, so a file created between the
 * two is seen by the watch. */
export function waitForEndpoint(config) {
  const file = join(config, "endpoint.json");
  return new Promise((done, fail) => {
    const watcher = watch(config, () => {
      if (existsSync(file)) {
        watcher.close();
        done();
      }
    });
    watcher.on("error", (error) => {
      watcher.close();
      fail(error);
    });
    if (existsSync(file)) {
      watcher.close();
      done();
    }
  });
}

/** The name of the first window of a `host.windows` value that is ready, or null when none is. */
export function readyWindow(windows) {
  const ready = windows.find((window) => window.ready === true);
  return ready ? ready.window : null;
}

/** Runs the status watch of `host.windows` with the command and its arguments, and resolves with the name of the first ready window. The
 * watch ends when the window is ready, and the promise rejects when the watch ends before that. */
export function waitForReady(command, args) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buffered = "";
    let stderr = "";
    let settled = false;
    const finish = (error, name) => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (error) fail(error);
      else done(name);
    };
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (line === "") continue;
        const name = readyWindow(JSON.parse(line) ?? []);
        if (name !== null) return finish(null, name);
      }
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(new Error(`the status watch ended with ${code} before a window was ready: ${stderr.trim()}`)));
  });
}
