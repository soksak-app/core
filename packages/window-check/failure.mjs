// The failure of a check that several errors end: the one source of the failures that join errors in the window checks.

/**
 * The failure `label` of the errors `errors`, which keeps them as its errors. Its message names the message of each error after the
 * label, because a test report and a log of the check show only the message of an AggregateError and not its errors.
 */
export function joinedFailure(label, errors) {
  return new AggregateError(errors, `${label}: ${errors.map((error) => error?.message ?? String(error)).join("; ")}`);
}
