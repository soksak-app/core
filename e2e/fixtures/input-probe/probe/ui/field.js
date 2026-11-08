// The document of the native document region of the input probe: one text field that fills the region, observed by the input
// log. The document exchanges messages with the view through its own window (docs/spec/native-surfaces.md#document-regions):
// the host forwards each message that this window receives to the view, and posts each message of the view to this window, so
// both sides see every message and each side acts only on the kind that the other side sends.
import { createInputLog } from "./input-log.js";

const log = createInputLog(document.getElementById("field"), window);
const send = (message) => window.postMessage(message, location.origin);
// Each change of the log goes to the view as the whole state, so the view holds the state of the last message.
log.subscribe((state) => send({ probeinput: "state", state }));
const actions = {
  clear: () => log.clear(),
  select: (params) => log.select(params),
  clock: () => log.clock(),
};
window.addEventListener("message", (event) => {
  if (event.data?.probeinput !== "request") return;
  const { id, action, params } = event.data;
  try {
    const result = actions[action](params);
    // default: an action without a result replies null.
    send({ probeinput: "reply", id, result: result ?? null, state: log.read() });
  } catch (error) {
    // default: a thrown value that is not an Error carries its value as the text.
    send({ probeinput: "reply", id, error: String(error?.message ?? error), state: log.read() });
  }
});
send({ probeinput: "state", state: log.read() });
