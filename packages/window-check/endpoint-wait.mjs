// Waits for the endpoint of the process that replaces a running application (docs/spec/endpoint.md#diagnostic-builds).
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";

/**
 * Waits until `<configDir>/endpoint.json` names a process other than `previous` and returns its content. The host writes
 * the file through a temporary file that it renames, so a file that exists is complete; a change watch (fs.watch) on the
 * folder reads the file again at each notification, and the file is read once after the watch starts for a process that
 * wrote it before. A file that is not JSON is an error at once; at the deadline the wait rejects with the content it read.
 */
export function untilEndpoint(configDir, previous, timeout) {
  const file = join(configDir, "endpoint.json");
  return new Promise((resolve, reject) => {
    let last = "no file";
    let finished = false;
    const finish = (settle, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      watcher.close();
      settle(value);
    };
    const check = () => {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          last = "no file";
          return;
        }
        finish(reject, error);
        return;
      }
      let endpoint;
      try {
        endpoint = JSON.parse(text);
      } catch (error) {
        finish(reject, new SyntaxError(`${file} is not JSON: ${error.message}`));
        return;
      }
      last = JSON.stringify(endpoint);
      if (endpoint?.pid !== previous) finish(resolve, endpoint);
    };
    const watcher = watch(configDir, () => check());
    watcher.on("error", (error) => finish(reject, error));
    // The deadline bounds the wait; the result is judged by the content of the file.
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      watcher.close();
      reject(new Error(`${file} named no process other than ${previous} within ${timeout} ms; it holds ${last}`));
    }, timeout);
    check();
  });
}
