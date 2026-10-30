// The writer thread of folder-wait-churn.mjs: it creates, renames and removes files and nested folders in the folder of
// its worker data without pause.
import fs from "node:fs";
import { join } from "node:path";
import { workerData as folder } from "node:worker_threads";

for (let i = 0; ; i++) {
  const nested = join(folder, "nested-" + (i % 4));
  fs.mkdirSync(join(nested, "a", "b"), { recursive: true });
  fs.writeFileSync(join(nested, "a", "file"), String(i));
  fs.renameSync(join(nested, "a", "file"), join(nested, "moved"));
  fs.writeFileSync(join(folder, ".state.tmp"), String(i));
  fs.renameSync(join(folder, ".state.tmp"), join(folder, "state"));
  fs.rmSync(nested, { recursive: true });
}
