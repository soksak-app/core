/**
 * The call recorder. It sends each call and its reply to the application log, one line each.
 *
 * The application can handle the calls of the page on several threads at the same time. If a line were sent
 * as soon as it is received, an earlier line could arrive later, so the next line is sent after the transmission of the previous line ends.
 *
 * send(line) sends one line to the application and returns its completion as a promise.
 */
// default: a rejection value may not be an Error, so the value itself is written.
export function createTranscript(send, reportError = (error) => console.error("transcript send failed:", error?.message ?? error)) {
  let recording = false;
  let sent = Promise.resolve();

  /** Writes a call without a reply in one form. Each framework has a different form of an empty reply. */
  const say = (value) => {
    const empty = value == null ||
      (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
    return empty ? "null" : JSON.stringify(value);
  };

  return {
    /** Turns the recording on or off. */
    set(on) {
      recording = on === true;
    },

    /**
     * When the reply answered of the call name appears, it sends a line. Lines are sent in the order the replies appeared.
     * A failed call is reported by the caller, so it is not written.
     */
    record(name, payload, answered) {
      if (!recording) return;
      Promise.resolve(answered).then((answer) => {
        const line = `host ${name} ${say(payload)} -> ${say(answer)}`;
        sent = sent.then(() => send(line)).then(undefined, reportError);
      // default: a rejection value may not be an Error, so the value itself is written.
      }, (error) => reportError(new Error(`host ${name} failed before transcript: ${error?.message ?? error}`)));
    },
  };
}
