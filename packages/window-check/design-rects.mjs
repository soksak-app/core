// Compares the places of the workbench elements that each host shows in the same states. The workbench of each host draws the
// chrome metrics of packages/workbench/workbench.json, so one element stands at one place on every host.

/** The largest distance in window points at which two places of one element are the same place. */
export const DESIGN_TOLERANCE = 1;

const place = (rect) => (rect ? `${rect.x},${rect.y} ${rect.width}x${rect.height}` : "absent");

const apart = (a, b, tolerance) => ["x", "y", "width", "height"].some((key) => Math.abs(a[key] - b[key]) > tolerance);

/**
 * The differences between the hosts of readings, which maps each host to its states, each state to its element names and each name
 * to the window rectangles of its shown elements in element order. A difference is a state that one host did not reach, an element
 * that one host shows and another does not, or an element whose rectangles on two hosts are apart by more than tolerance.
 */
export function designDifferences(readings, tolerance = DESIGN_TOLERANCE) {
  const hosts = Object.keys(readings);
  const union = (lists) => [...new Set(lists.flat())].sort();
  const differences = [];
  for (const state of union(hosts.map((host) => Object.keys(readings[host])))) {
    const missing = hosts.filter((host) => !readings[host][state]);
    if (missing.length) {
      differences.push(`${state}: not reached on ${missing.join(", ")}`);
      continue;
    }
    for (const name of union(hosts.map((host) => Object.keys(readings[host][state])))) {
      const count = Math.max(...hosts.map((host) => readings[host][state][name]?.length ?? 0));
      for (let index = 0; index < count; index += 1) {
        const rects = hosts.map((host) => readings[host][state][name]?.[index]);
        const differ = rects.some((rect) => !rect) ||
          rects.some((rect, i) => rects.slice(i + 1).some((other) => apart(rect, other, tolerance)));
        if (differ) differences.push(`${state} ${name}[${index}]: ${hosts.map((host, i) => `${host} ${place(rects[i])}`).join("; ")}`);
      }
    }
  }
  return differences;
}
