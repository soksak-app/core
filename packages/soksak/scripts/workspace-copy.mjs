/**
 * A copy of what the suite reads, in the workspace layout.
 *
 * Break and mutation runs write defects into a copy. The suite reads the
 * package and, through the same relative paths, files at the workspace root:
 * the toolchain declarations and the shared layout cases. A part missing here
 * fails every run of the copy before any defect is written.
 */
import { cpSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;

/** The package parts the suite reads. */
const PACKAGE_PARTS = ["dist", "test", "scripts", "src", "docs", "package.json", "tsconfig.json"];
/** The workspace root parts the suite reads, and the execution evidence reader with its reporter, which judge each run of the copy. */
const ROOT_PARTS = ["package.json", "Makefile", ".node-version", "docs/spec/cases/layout", "scripts/node-test-evidence.mjs", "scripts/test-event-reporter.mjs"];

/**
 * Copies the parts into a new directory named with prefix; returns the copy's root and its package directory.
 * The parts come from the workspace, or from an earlier copy given as from: a run that measures several
 * defects copies its snapshot for each one, so an edit of the workspace during the run reaches none of them.
 */
export function copyWorkspace(prefix, from = { top: ROOT, root: REPO }) {
  const top = `${mkdtempSync(join(tmpdir(), prefix))}/`;
  const root = `${top}packages/soksak/`;
  for (const part of PACKAGE_PARTS) cpSync(`${from.root}${part}`, `${root}${part}`, { recursive: true });
  for (const part of ROOT_PARTS) cpSync(`${from.top}${part}`, `${top}${part}`, { recursive: true });
  // jsdom is what the view is rendered into. Link the tree rather than copy it — the run only reads it.
  symlinkSync(`${REPO}node_modules`, `${root}node_modules`);
  return { top, root };
}
