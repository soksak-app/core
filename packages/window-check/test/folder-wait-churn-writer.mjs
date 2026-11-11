// The writer thread of folder-wait-churn.mjs: it creates, renames and removes files and nested folders in the folder of
// its worker data without pause, and writes its progress every 100 changes when the worker data names a progress file.
// A rename that answered ENOENT and took place (folder-wait-churn-rename.mjs) is a change, and the progress file receives a
// line that names it.
import fs from "node:fs";
import { join } from "node:path";
import { workerData } from "node:worker_threads";
import { renameChange } from "./folder-wait-churn-rename.mjs";

const { folder, progressFile } = workerData;
const rename = (from, to, content, change) => {
  if (renameChange(from, to, content, change) && progressFile) {
    fs.appendFileSync(progressFile, `writer change ${change}: the rename to ${to} answered ENOENT and took place\n`);
  }
};
for (let i = 0; ; i++) {
  if (progressFile && i % 100 === 0) fs.appendFileSync(progressFile, `writer change ${i}\n`);
  const nested = join(folder, "nested-" + (i % 4));
  fs.mkdirSync(join(nested, "a", "b"), { recursive: true });
  fs.writeFileSync(join(nested, "a", "file"), String(i));
  rename(join(nested, "a", "file"), join(nested, "moved"), String(i), i);
  fs.writeFileSync(join(folder, ".state.tmp"), String(i));
  rename(join(folder, ".state.tmp"), join(folder, "state"), String(i), i);
  fs.rmSync(nested, { recursive: true });
}
