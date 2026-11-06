// The process warnings of node that the runners judge. A warning is a failure of the build or test that printed it: the test runner
// (test-runner.mjs) fails the process and the language adapter (language-test-adapters.mjs) fails the case.

// A process warning of node: `(node:<pid>) [<code>] <Name>Warning: <message>`.
const PROCESS_WARNING = /^\(node:\d+\) (?:\[[A-Z0-9_]+\] )?([A-Za-z]*Warning): (.*)$/gm;

/** The process warnings of node in `output`, each once, as errors that name the warning and its message. */
export function processWarnings(output) {
  return [...new Set([...output.matchAll(PROCESS_WARNING)].map(([, name, message]) => `node printed ${name}: ${message}`))];
}
