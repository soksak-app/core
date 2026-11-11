// The rename of a change of test/folder-wait-churn-writer.mjs. macOS answered ENOENT for a rename of the writer that took
// place: the target held the content of that change and the listing of the folder held no source, while a lookup of the
// source still found it (docs/features.md F525-1). A listing reads the folder from the file system and a lookup can answer
// from the name cache of the kernel, so the listing decides. A rename that answers ENOENT is a change that took place when
// the listing of the folder of the source holds no source and the target holds the content that the writer wrote to the
// source. Every other failure throws with the change, what the target holds, and whether the listing and a lookup find the
// source, which tells a source that something removed (the target holds an earlier change) from a rename that took place.
import fs from "node:fs";
import { basename, dirname } from "node:path";

/**
 * Renames `from` to `to` with `rename` and returns false, or returns true for a rename that answered ENOENT and took place:
 * the listing of the folder of `from` holds no `from` and `to` holds `content`. Every other failure throws.
 */
export function renameChange(from, to, content, change, rename = fs.renameSync) {
  try {
    rename(from, to);
    return false;
  } catch (error) {
    const listed = fs.readdirSync(dirname(from)).includes(basename(from));
    let held;
    try {
      held = fs.readFileSync(to, "utf8");
    } catch (readError) {
      held = `unreadable: ${readError.code ?? readError.message}`;
    }
    if (error.code === "ENOENT" && !listed && held === content) return true;
    error.message += ` at change ${change}; ${basename(to)} holds ${held}; ${basename(from)} is ${listed ? "" : "not "}listed`
      + ` and ${fs.existsSync(from) ? "" : "not "}found`;
    throw error;
  }
}
