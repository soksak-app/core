// The log policy that a window check needs (docs/spec/logging.md#policy). The default policy stores only `error`, so a check
// that reads a record below `error` declares the policy that stores it and the records that it reads; a declaration or a
// policy file that does not store a record that the check reads is an error that names the record and the policy, and the
// check fails at once instead of waiting until its deadline.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { endSignal, untilFolderState } from "./folder-wait.mjs";
import { declaration, DEFAULT_POLICY, parsePolicy, POLICY_CLASSES, POLICY_SCHEMA, policyAllows, policyIsBeingWritten } from "@soksak/log-contract";

/** The value of the setting `diagnostics.log` that stores every level of every class, as `core.settings.debug {on: true}` sets it. */
export const EVERY_LEVEL = Object.freeze(Object.fromEntries(POLICY_CLASSES.map((kind) => [kind, "trace"])));

/**
 * The policy that a value of the setting `diagnostics.log` puts in force: each class that the value names at its level and every
 * other class at the default policy. A class or a level outside the contract is refused with the error of `parsePolicy`.
 */
export function policyOfSetting(setting) {
  const classes = { ...DEFAULT_POLICY.classes, ...setting };
  return parsePolicy("the setting diagnostics.log", JSON.stringify({ schema: POLICY_SCHEMA, classes }));
}

/** The file of the policy of a configuration folder. */
export const policyFile = (configDir) => join(configDir, "log-policy.json");

/** The text of the policy file of a configuration folder, or null while the file does not exist. */
function policyText(configDir) {
  try {
    return readFileSync(policyFile(configDir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** The policy in force in a configuration folder: its policy file, or the default policy while the file does not exist. */
export function readPolicy(configDir) {
  const text = policyText(configDir);
  // The default policy is in force while no policy file exists (docs/spec/logging.md#policy-file).
  return text === null ? DEFAULT_POLICY : parsePolicy(policyFile(configDir), text);
}

/**
 * The events that pass every gate (docs/spec/logging.md#policy): the events that a writer reports about itself, the counts of the
 * gates and the start of a document of the workbench and of a view page.
 */
const UNGATED = new Set(["log.open", "log.rotated", "log.dropped", "log.policy", "log.gated", "log.pruned",
  "workbench.log.gated", "page.log.gated", "native.log.gated", "workbench.start", "page.start"]);

/**
 * Throws when the policy does not store every declared level of a record that the check reads. `catalog` holds the declarations
 * of the records (docs/spec/events.json and the catalogs of the installed sidecars); `source` names where the policy comes from.
 */
export function requireStored(policy, catalog, records, source) {
  const unstored = [];
  for (const name of records) {
    if (UNGATED.has(name)) continue;
    const declared = declaration(catalog, name);
    if (declared === undefined) throw new Error(`the check reads ${name}, which the catalog does not declare`);
    // A record of a family `<layer>.record.<level>` names its level as its last part; another record may be stored at any of
    // its declared levels, so the policy must store each of them.
    const named = name.split(".").at(-1);
    const levels = [declared.level].flat().includes(named) ? [named] : [declared.level].flat();
    if (!levels.every((level) => policyAllows(policy, declared.class, level))) {
      unstored.push(`${name} (class ${declared.class}, level ${levels.join(" and ")})`);
    }
  }
  if (unstored.length) {
    throw new Error(`the check reads ${unstored.join(", ")}, which the log policy ${JSON.stringify(policy.classes)} of ${source} does not store`);
  }
}

/**
 * Waits until the policy in force in the configuration folder is `policy`. The host writes the file when the page sends it the
 * policy of the setting, so the file is read once the change watch of the folder is active and again at each change
 * (folder-wait.mjs); a file that a writer is writing is read at the next change. The wait has no time limit: the policy or an
 * error ends it, and `ended`, a promise that settles when the host that writes the file ends, such as `client.ended` of its
 * endpoint connection, rejects it with an error that names the file and the policy it holds.
 */
export async function untilPolicy(configDir, policy, options = {}, ...rest) {
  if (typeof options !== "object" || options === null || rest.length > 0) {
    throw new TypeError("untilPolicy takes no limit: a wait ends by the policy, an error or the end of the host");
  }
  const expected = JSON.stringify(policy.classes);
  let found = "nothing read";
  const read = () => {
    const text = policyText(configDir);
    if (text !== null && policyIsBeingWritten(text)) return undefined;
    found = JSON.stringify(readPolicy(configDir).classes);
    return found === expected ? true : undefined;
  };
  const signal = options.ended === undefined ? undefined : endSignal(options.ended);
  try {
    await untilFolderState(configDir, read, { signal });
  } catch (error) {
    if (!signal?.aborted || error !== signal.reason) throw error;
    throw new Error(`${policyFile(configDir)} did not hold the log policy ${expected} before the host ended ` +
      `(${error?.message ?? error}); it holds ${found}`, { cause: error });
  }
}
