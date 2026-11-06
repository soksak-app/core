/** Shared execution and retained evidence for required and exploratory mutations. */
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runBounded } from "./bounded.mjs";
import { NODE_TEST_REPORTERS, readNodeTestEvidence } from "../../../scripts/node-test-evidence.mjs";

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
  let classification;
  if (execution.error || !["exit", "deadline"].includes(execution.reason)) classification = "environment-error";
  else if (execution.reason === "deadline") classification = "mutant-timeout";
  // A signal without a supervisor cause does not identify who terminated the process.
  else if (execution.signal) classification = "environment-error";
  else if (execution.code === 0) classification = testEvidence.errors.length ? "environment-error" : "passed";
  else if (/\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_INVALID_PACKAGE_CONFIG|ENOENT|ENOSPC|EACCES|EMFILE|ENFILE|ENOMEM)\b|bad option:|Could not find /.test(output)) classification = "environment-error";
  else if (/\bERR_ASSERTION\b/.test(output)) classification = "assertion-failure";
  else classification = "runtime-failure";
  const result = { ...execution, classification, file, timeout, testEvidence, stdout, stderr, record };
  writeFileSync(record, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}
