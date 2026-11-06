/** A small required set for each changed implementation owner; exploratory runs stay separate. */
import { execFileSync } from "node:child_process";

export const REQUIRED_BREAKS = Object.freeze([
  { owner: "soksak", id: "state", tests: ["test/soksak.test.mjs"] },
  { owner: "slicing", id: "slicing", tests: ["test/rules.test.mjs"] },
  { owner: "geometry", id: "corridor", tests: ["test/fixedSize.test.mjs"] },
  { owner: "card", id: "spanning-size", tests: ["test/fixedSize.test.mjs", "test/rules.test.mjs"] },
  { owner: "balance", id: "balance-share", tests: ["test/balance.test.mjs"] },
  { owner: "outline", id: "radius", tests: ["test/outline.test.mjs"] },
  { owner: "dom", id: "place", tests: ["test/dom.test.mjs"] },
  { owner: "theme", id: "grip-active", tests: ["test/dom.test.mjs"] },
]);

const shared = new Set([
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".node-version",
  ".github/workflows/ci.yml", "scripts/node-test-evidence.mjs", "scripts/test-event-reporter.mjs",
  "packages/soksak/package.json", "packages/soksak/tsconfig.json", "packages/soksak/src/index.ts",
  "packages/soksak/dist/index.js", "packages/soksak/test/helpers.mjs",
]);

export function selectRequiredBreaks(files) {
  const selected = new Set();
  let all = false;
  for (const file of files) {
    if (shared.has(file) || file.startsWith("packages/soksak/scripts/") || file.startsWith("packages/soksak/docs/")) {
      all = true;
      continue;
    }
    const source = /^packages\/soksak\/(?:src\/([^/]+)\.ts|dist\/([^/]+)\.js)$/.exec(file);
    if (source) {
      const entry = REQUIRED_BREAKS.find(({ owner }) => owner === (source[1] ?? source[2]));
      if (!entry) throw new Error(`${file}: no required mutation owner`);
      selected.add(entry.id);
    }
    const owners = REQUIRED_BREAKS.filter((entry) => entry.tests.some((test) => file === `packages/soksak/${test}`));
    for (const entry of owners) selected.add(entry.id);
    // Cross-owner invariant and helper tests exercise the complete required set.
    if (!owners.length && file.startsWith("packages/soksak/test/")) all = true;
  }
  return all ? [...REQUIRED_BREAKS] : REQUIRED_BREAKS.filter(({ id }) => selected.has(id));
}

export function changedMutationFiles(root, range) {
  if (typeof range !== "string" || !/^[\w/.~^:-]+\.{2,3}[\w/.~^:-]+$/.test(range) || range.startsWith("-")) {
    throw new Error("A revision range is required for changed mutation owners");
  }
  // The first push has no earlier tree. It still verifies every current owner.
  const initial = /^0+\.{2,3}(.+)$/.exec(range);
  const args = initial ? ["ls-tree", "-r", "--name-only", "-z", initial[1]] : ["diff", "--name-only", "-z", range, "--"];
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}
