// The check of a late surface reply judges lines of the application log (docs/spec/exposure.md#relay).
//
// When the host removes a surface, it ends the requests sent to that surface with 1003, so a reply of the surface that arrives later has no request to answer.
// The host discards that reply and writes an observation line, and it writes no error line.

/** Escapes the characters that have a special meaning in a regular expression so that they match literally. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The observation line of a host that discarded the late reply of the surface surface. Both hosts write the surface id in quotation marks. */
const observation = (surface) =>
  new RegExp(`^info host exposure: exposure reply \\d+ of removed surface ${literal(JSON.stringify(surface))} arrived after its request ended$`);

/** The line that the page writes when it sent the held reply after the surface was removed (diagnostics.surface.hold in docs/spec/endpoint.md). */
export const heldRepliesSent = (surface, count) =>
  `info page page: held exposure replies of surface ${JSON.stringify(surface)} were sent after the surface closed (${count})`;

/** The observation of the late reply of surface and the error lines among the log lines. */
export function lateReplyFindings(lines, surface) {
  const pattern = observation(surface);
  return {
    observations: lines.filter((line) => pattern.test(line)),
    errors: lines.filter((line) => line.startsWith("error ")),
  };
}
