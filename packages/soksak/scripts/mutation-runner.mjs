/** Shared execution and retained evidence for required and exploratory mutations. */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runBounded } from "./bounded.mjs";
import { NODE_TEST_REPORTERS, readNodeTestEvidence } from "../../../scripts/node-test-evidence.mjs";
import { EVENT_PREFIX } from "../../../scripts/test-event-reporter.mjs";

const ENVIRONMENT_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_INVALID_PACKAGE_CONFIG", "ENOENT", "ENOSPC", "EACCES", "EMFILE", "ENFILE", "ENOMEM"]);
const loaderFailure = new RegExp(`^(?:#\\s*)?(?:Error|TypeError|SyntaxError)(?: \\[(?:${[...ENVIRONMENT_CODES].join("|")})\\]:|: (?:${[...ENVIRONMENT_CODES].join("|")}):)`, "m");

/**
 * Creates the folder of the evidence of a mutation run, with the name prefix `prefix`. The evidence outlives the run, so the folder lies
 * under `SOKSAK_MUTATION_RUN_FOLDER` of `env`, or else under target/mutation-runs of the repository `root`, and never in the temporary
 * folder (docs/operations/examples.md#temporary-folders).
 */
export function evidenceFolder(root, prefix, env = process.env) {
  const parent = env.SOKSAK_MUTATION_RUN_FOLDER ?? resolve(root, "target", "mutation-runs");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

export function mutationVerdict({ classification }) {
  if (classification === "passed") return "survived";
  if (["assertion-failure", "runtime-failure", "mutant-timeout"].includes(classification)) return "caught";
  if (classification === "environment-error") return "invalid";
  throw new Error(`Unknown mutation classification: ${classification}`);
}

export async function runMutationTest({ root, file, timeout, evidence, signal, onSpawn }) {
  const testFile = realpathSync(resolve(root, file));
  mkdirSync(evidence, { recursive: true });
  const stdout = `${evidence}/stdout.log`, stderr = `${evidence}/stderr.log`, record = `${evidence}/result.json`;
  const out = openSync(stdout, "wx");
  let err;
  let execution;
  try {
    err = openSync(stderr, "wx");
    execution = await runBounded(process.execPath, ["--test", ...NODE_TEST_REPORTERS, testFile], {
      cwd: root, timeout, stdout: out, stderr: err, signal, onSpawn,
    });
  } finally {
    closeSync(out);
    if (err !== undefined) closeSync(err);
  }
  const output = readFileSync(stdout, "utf8") + readFileSync(stderr, "utf8");
  const testEvidence = readNodeTestEvidence(output, [testFile]);
  const events = output.split("\n").filter((line) => line.startsWith(EVENT_PREFIX))
    .map((line) => JSON.parse(line.slice(EVENT_PREFIX.length)));
  const testSignals = events.map(({ signal }) => signal).filter(Boolean);
  const errorCodes = events.map(({ errorCode }) => errorCode).filter(Boolean);
  const failureTypes = events.map(({ failureType }) => failureType).filter(Boolean);
  let classification;
  if (execution.error || !["exit", "deadline"].includes(execution.reason)) classification = "environment-error";
  else if (execution.reason === "deadline") classification = "mutant-timeout";
  // A signal without a supervisor cause does not identify who terminated the process.
  else if (execution.signal || testSignals.length) classification = "environment-error";
  else if (errorCodes.some((code) => ENVIRONMENT_CODES.has(code))) classification = "environment-error";
  else if (failureTypes.includes("testTimeoutFailure")) classification = "mutant-timeout";
  else if (execution.code === 0) classification = testEvidence.errors.length ? "environment-error" : "passed";
  // A loader or Node startup error can precede registration of any test. A test's diagnostic text is never its error code.
  else if (testEvidence.actual.tests === 0 && (loaderFailure.test(output) || /^.*node(?:\.exe)?: bad option:|^Could not find /m.test(output))) classification = "environment-error";
  else if (errorCodes.includes("ERR_ASSERTION")) classification = "assertion-failure";
  else classification = "runtime-failure";
  const result = { ...execution, classification, file, timeout, testEvidence, testSignals, errorCodes, failureTypes, stdout, stderr, record };
  writeFileSync(record, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}
