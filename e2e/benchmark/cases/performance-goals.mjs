// The bounds of the performance goals that the benchmarks judge themselves (docs/spec/performance-goals.json): the idle tab case reads
// IDLE_TAB_BOUND_KB and the split load case SPLIT_LOAD_GROWTH_BOUND_KB from the value that names the constant, so the benchmarks and
// B3 judge the same bound and no benchmark keeps a copy of it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GOALS = fileURLToPath(new URL("../../../docs/spec/performance-goals.json", import.meta.url));

/**
 * The member `kind` (`atMost`, `below`, …) of the bound of the one value of the goals file whose `constant` is `constant`. No value or
 * more than one value with the constant, or a bound without a finite number in `kind`, is an error that names the file.
 */
export function performanceGoalBound(constant, kind, path = GOALS) {
  const { values } = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(values)) throw new Error(`${path}: values is not a list`);
  const named = values.filter((value) => value?.constant === constant);
  if (named.length !== 1) throw new Error(`${path}: ${named.length} values have the constant ${constant}; exactly one must have it`);
  const [{ id, bound }] = named;
  if (!Number.isFinite(bound?.[kind])) throw new Error(`${path}: the bound of ${id} (${constant}) has no finite ${kind}: ${JSON.stringify(bound)}`);
  return bound[kind];
}
