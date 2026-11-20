/**
 * Can these spans be cut apart by whole-width and whole-height cuts?
 *
 * Worked out here from the derived cells rather than read from the stored
 * tree: the cells are the answer under test, and a test that reads the tree
 * the implementation keeps passes whatever the implementation derives.
 */
export function guillotine(spans) {
  if (spans.length <= 1) return true;
  for (const [lo, hi] of [["c0", "c1"], ["r0", "r1"]]) {
    for (const line of [...new Set(spans.map((s) => s[lo]))].sort((a, b) => a - b)) {
      const before = spans.filter((s) => s[hi] <= line);
      const after = spans.filter((s) => s[lo] >= line);
      if (before.length && after.length && before.length + after.length === spans.length) {
        return guillotine(before) && guillotine(after);
      }
    }
  }
  return false;
}
