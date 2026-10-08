// The order of the files in the debug view: the newest first, and files of the same time by path
// (docs/spec/debug.md).

/** The entries of the debug files `{path, size, modified}` in the order of the list; the argument is not changed. */
export function newestFirst(entries) {
  return entries.toSorted((left, right) => {
    if (left.modified !== right.modified) return right.modified - left.modified;
    return left.path.localeCompare(right.path);
  });
}
