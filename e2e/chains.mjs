// The chains of the operations of the workbench that the core checks perform (docs/spec/logging.md#operation-chains): the declared
// chains of the core catalog. The search of a chain in the log is @soksak/window-check/chains.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CATALOG = fileURLToPath(new URL("../docs/spec/events.json", import.meta.url));
/** The chains that the check performs. */
export const PERFORMED = ["plugin", "project", "settings", "update", "window"];
/** The chains that another check performs, by the file of that check. */
const PERFORMED_ELSEWHERE = { input: "e2e/input-records.test.mjs" };

/** The declared chains of the catalog: the name of each chain and its events, the first event first. */
export function declaredChains(path = CATALOG) {
  const { chains } = JSON.parse(readFileSync(path, "utf8"));
  const performed = [...Object.entries(PERFORMED_ELSEWHERE).map(([name, file]) => `${name} (${file})`), ...PERFORMED];
  assert.deepEqual(Object.keys(chains).toSorted(), [...Object.keys(PERFORMED_ELSEWHERE), ...PERFORMED].toSorted(),
    `the catalog declares the chains ${Object.keys(chains).join(", ")}, and the checks perform ${performed.slice(0, -1).join(", ")} and ${performed.at(-1)}`);
  return chains;
}
