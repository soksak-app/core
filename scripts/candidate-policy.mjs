import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The hosts of a candidate in sorted order: each has its release job, its release artifact and its applications in the window checks. */
export const CANDIDATE_HOSTS = Object.freeze(['mygo', 'tauriv2', 'wailsv3']);

/** The platform of the candidate release artifacts; the platform operations of its plan and its release keys are those of this platform. */
export const CANDIDATE_PLATFORM = Object.freeze({ platform: 'darwin', arch: 'arm64' });

/** Acceptance reuses the declared application, activation and dedicated performance scripts. */
export function candidateScripts(root) {
  const { scripts } = JSON.parse(readFileSync(join(root, 'e2e', 'package.json'), 'utf8'));
  const required = ['test-app', 'test-app:activation'];
  for (const script of required) if (!scripts?.[script]) throw new Error(`e2e/package.json: missing required candidate script ${script}`);
  const benchmarks = Object.keys(scripts).filter((name) => name.startsWith('benchmark:')).sort();
  if (!benchmarks.length) throw new Error('e2e/package.json: no dedicated candidate benchmarks');
  return [...required, ...benchmarks];
}

/** Reads the declared native runner entries, including each mode argument, without starting make or a build. */
export function candidateNativeTests(root, script) {
  const target = script === 'test-app' ? 'test-app' : script === 'test-app:activation' ? 'test-app-activation' : null;
  if (target === null) return [];
  const makefile = readFileSync(join(root, 'native/darwin/Makefile'), 'utf8');
  const recipe = new RegExp(`^${target}:[^\\n]*\\n((?:\\t[^\\n]*\\n)*)`, 'm').exec(makefile)?.[1];
  // The recipe is `@[NAME="value" ...] node <runner> <build> <entries>`: the environment that its cases read, then the runner.
  let entries = /@(?:[A-Z_][A-Z0-9_]*="[^"]*" )*node \$\(NATIVE_TEST_RUNNER\) \$\(abspath \$\(BUILD\)\) (.+)/.exec(recipe ?? '')?.[1];
  if (entries === '$(NATIVE_E2E_TESTS)') entries = /^NATIVE_E2E_TESTS\s*=\s*((?:[^\n]*\\\n)*[^\n]*)/m.exec(makefile)?.[1].replace(/\\\n/g, ' ');
  if (!entries || entries.includes('$')) throw new Error(`native/darwin/Makefile: cannot identify the complete ${target} runner entries`);
  return entries.trim().split(/\s+/).map((entry) => entry.replaceAll(',', ' '));
}
