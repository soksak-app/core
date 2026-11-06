// The node:test reporter that the test runner reads (docs/operations/examples.md#test-parity). It writes one line per test event to the
// standard error, prefixed by EVENT_PREFIX, so the runner resets the event watchdog of the file at each event. The TAP form on the
// standard output and the other lines of the standard error are the output of the file, which the runner keeps. A line also carries the `nesting` of the test, so
// the runner pairs the `test:dequeue` of each test with its `test:complete`, and the `exitCode` and `signal` of the error of a
// `test:complete`, which node --test sets on the result of a test file whose process ended with a status other than 0 or a signal. The
// `test:summary` of a file (the summary that names its `file`) carries the `counts` of its tests, from which the runner reads how many
// tests the file ran; the last summary of node --test names no file and counts a file that ran no test as one test.
// A summary also carries `success`, and a `test:complete` its `skip` and `todo` flags: the file-owned summary shows that the file ran its
// tests, and the flags keep skipped or todo suites, which the counts of the summary do not include.
export const EVENT_PREFIX = "@soksak-test-event ";

export default async function* testEvents(source) {
  for await (const event of source) {
    if (!event.type.startsWith("test:")) continue;
    const name = typeof event.data?.name === "string" ? event.data.name : "";
    const line = { type: event.type, name, nesting: event.data?.nesting };
    if (event.type === "test:complete") Object.assign(line, { skip: event.data.skip, todo: event.data.todo });
    const error = event.type === "test:complete" ? event.data?.details?.error : undefined;
    if (error !== undefined && error !== null) {
      const code = error.cause?.code ?? error.code;
      if (typeof code === "string") line.errorCode = code;
      if (typeof error.failureType === "string") line.failureType = error.failureType;
    }
    if (error !== undefined && error !== null && Object.hasOwn(error, "exitCode")) Object.assign(line, { exitCode: error.exitCode, signal: error.signal });
    if (event.type === "test:summary" && typeof event.data?.file === "string") Object.assign(line, { file: event.data.file, success: event.data.success, counts: event.data.counts });
    yield `${EVENT_PREFIX}${JSON.stringify(line)}\n`;
  }
}
