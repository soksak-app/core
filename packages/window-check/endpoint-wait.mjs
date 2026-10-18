// Waits for the endpoint of the process that replaces a running application (docs/spec/endpoint.md#diagnostic-builds).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { untilFolderState } from "./folder-wait.mjs";

/**
 * Waits until `<configDir>/endpoint.json` names a process other than `previous` and returns its content. The host writes
 * the file through a temporary file that it renames, so a file that exists is complete; the file is read once the change
 * watch of the folder is active and again at each change (folder-wait.mjs), so a process that wrote it before or at
 * once after the wait started is found. A file that is not JSON is an error at once; at the deadline the wait rejects
 * with the content it read.
 */
export function untilEndpoint(configDir, previous, timeout) {
  const file = join(configDir, "endpoint.json");
  let last = "no file";
  const read = () => {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      last = "no file";
      return undefined;
    }
    let endpoint;
    try {
      endpoint = JSON.parse(text);
    } catch (error) {
      throw new SyntaxError(`${file} is not JSON: ${error.message}`);
    }
    last = JSON.stringify(endpoint);
    return endpoint?.pid !== previous ? endpoint : undefined;
  };
  return untilFolderState(configDir, read, timeout,
    () => new Error(`${file} named no process other than ${previous} within ${timeout} ms; it holds ${last}`));
}
