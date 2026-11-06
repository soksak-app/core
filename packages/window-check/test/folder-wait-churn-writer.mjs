// The writer thread of folder-wait-churn.mjs: it creates, renames and removes files and nested folders in the folder of
// its worker data without pause, and writes its progress every 100 changes when the worker data names a progress file.
import fs from "node:fs";
import { join } from "node:path";
import { workerData } from "node:worker_threads";

const { folder, progressFile } = workerData;
for (let i = 0; ; i++) {
  if (progressFile && i % 100 === 0) fs.appendFileSync(progressFile, `writer change ${i}\n`);
  const nested = join(folder, "nested-" + (i % 4));
  fs.mkdirSync(join(nested, "a", "b"), { recursive: true });
  fs.writeFileSync(join(nested, "a", "file"), String(i));
  fs.renameSync(join(nested, "a", "file"), join(nested, "moved"));
  fs.writeFileSync(join(folder, ".state.tmp"), String(i));
  try {
    fs.renameSync(join(folder, ".state.tmp"), join(folder, "state"));
  } catch (error) {
    // The change and the content of state tell a rename that took place and answered a failure (state holds this change)
    // from a temporary file that something removed before the rename (state holds an earlier change).
    let state;
    try {
      state = fs.readFileSync(join(folder, "state"), "utf8");
    } catch (readError) {
      state = `unreadable: ${readError.code ?? readError.message}`;
    }
    error.message += ` at change ${i}; state holds ${state}; .state.tmp ${fs.existsSync(join(folder, ".state.tmp")) ? "exists" : "is gone"}`;
    throw error;
  }
  fs.rmSync(nested, { recursive: true });
}
