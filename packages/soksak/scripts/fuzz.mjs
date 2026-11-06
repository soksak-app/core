/** Seeded layout profiles, checked after every public operation. */
import { createProfile, reduceSequence, runSequence } from "./layout-sequences.mjs";

const seeds = Number(process.argv[2] ?? 400);
const steps = Number(process.argv[3] ?? 120);
if (!Number.isSafeInteger(seeds) || seeds < 1 || !Number.isSafeInteger(steps) || steps < 1) {
  throw new Error("fuzz expects positive integer seed and step counts");
}
let failures = 0;
const profiles = {};
const totals = { successful: 0, refused: 0, changed: 0, unchanged: 0 };
for (let seed = 1; seed <= seeds; seed++) {
  let failed = false;
  for (const profile of ["ordinary", "fixed", "constrained"]) {
    const report = runSequence(createProfile(profile, seed), { seed, steps, profile });
    for (const key of Object.keys(totals)) totals[key] += report.counts[key];
    const byMethod = profiles[profile] ??= {};
    for (const [method, counts] of Object.entries(report.byMethod)) {
      const sum = byMethod[method] ??= { successful: 0, refused: 0, changed: 0, unchanged: 0 };
      for (const key of Object.keys(sum)) sum[key] += counts[key];
    }
    if (report.failure) {
      failed = true;
      // Publish the complete original before reduction, including if replay fails.
      console.error(JSON.stringify({ original: report }));
      if (report.failure.invariant !== "assertion" && !report.failure.invariant.startsWith("operation:")) {
        const { reduced, attempts } = reduceSequence(report);
        console.error(JSON.stringify({ reduced, attempts }));
      }
    }
  }
  if (failed) failures++;
}
console.log(`${failures}/${seeds} seeds failed; transitions ${JSON.stringify(totals)}`);
console.log(`profiles ${JSON.stringify(profiles)}`);
process.exitCode = failures ? 1 : 0;
