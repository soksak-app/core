// The node:test reporter that the test runner reads (docs/operations/examples.md#test-runner). It writes one line per test event to the
// standard error, prefixed by EVENT_PREFIX, so the runner resets the event watchdog of the file at each event. The other lines of the
// standard error are the TAP form, which the runner keeps as the output of the file. A line also carries the `nesting` of the test, so
// the runner pairs the `test:dequeue` of each test with its `test:complete`, and the `exitCode` and `signal` of the error of a
// `test:complete`, which node --test sets on the result of a test file whose process ended with a status other than 0 or a signal.
// The file-owned summary proves execution independently of the outer file wrapper. Completion flags also preserve skipped or
// todo suites, which are not included in the summary's skipped and todo test counts.
export const EVENT_PREFIX = "@soksak-test-event ";

export default async function* testEvents(source) {
  for await (const event of source) {
    if (!event.type.startsWith("test:")) continue;
    const name = typeof event.data?.name === "string" ? event.data.name : "";
    const line = { type: event.type, name, nesting: event.data?.nesting };
    if (event.type === "test:summary") Object.assign(line, { file: event.data.file, success: event.data.success, counts: event.data.counts });
    if (event.type === "test:complete") Object.assign(line, { skip: event.data.skip, todo: event.data.todo });
    const error = event.type === "test:complete" ? event.data?.details?.error : undefined;
    if (error !== undefined && error !== null && Object.hasOwn(error, "exitCode")) Object.assign(line, { exitCode: error.exitCode, signal: error.signal });
    yield `${EVENT_PREFIX}${JSON.stringify(line)}\n`;
  }
}
