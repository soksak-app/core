// The log policy that a window check needs (docs/spec/logging.md#policy). The default policy stores only `error`, so a check
// that reads a record below `error` declares the policy that stores it and the records that it reads; a declaration or a
// policy file that does not store a record that the check reads is an error that names the record and the policy, and the
// check fails at once instead of waiting until its deadline.
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";
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
 * The events that pass every gate (docs/spec/logging.md#policy): the events that a writer reports about itself, the record of a
 * stored-data migration, the counts of the gates and the start of a document of the page.
 */
const UNGATED = new Set(["log.open", "log.rotated", "log.dropped", "log.policy", "log.gated", "log.pruned", "log.migrated",
  "page.log.gated", "native.log.gated", "page.start"]);

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

/** How long the preparation waits until the host writes the policy of the setting to the policy file. */
const POLICY_LIMIT = 10000;

/**
 * Waits until the policy in force in the configuration folder is `policy`. The host writes the file when the page sends it the
 * policy of the setting, so a change watch of the folder reads the file again at each notification; a file that a writer is
 * writing is read at the next notification. When the limit passes, it rejects with an error that names the file and the policy
 * it holds.
 */
export function untilPolicy(configDir, policy, limit = POLICY_LIMIT) {
  const expected = JSON.stringify(policy.classes);
  return new Promise((resolve, reject) => {
    let found = "nothing read";
    let watcher;
    const finish = (error) => {
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      try {
        const text = policyText(configDir);
        if (text !== null && policyIsBeingWritten(text)) return;
        found = JSON.stringify(readPolicy(configDir).classes);
        if (found === expected) finish();
      } catch (error) {
        finish(error);
      }
    };
    const timer = setTimeout(() => {
      watcher?.close();
      reject(new Error(`${policyFile(configDir)} did not hold the log policy ${expected} within ${limit} ms; it holds ${found}`));
    }, limit);
    watcher = watch(configDir, check);
    check();
  });
}
