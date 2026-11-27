// The notice center file notices.json of the application configuration directory, read through the notices kind of the workspace bridge
// (docs/spec/notifications.md#notice-center, docs/spec/native-host.md#project-and-settings-operations). The file holds {format: 2, notices}.
import { notificationStore, onTabReports } from "./tab-reports.js";

export const NOTICES_FILE = "notices.json";
// The stop function of the writer that is registered on the notice store. The store is shared by every start of the page module, so the
// writer is kept here and not in a start: a start that opens the file again ends the writer of the earlier start (endNoticesWriter).
let stopWriter = null;

/** Ends the writer on the notice store, if one is registered; a later openNotices registers its own. */
export function endNoticesWriter() {
  const stop = stopWriter;
  stopWriter = null;
  stop?.();
}
const FORMAT = 2;
const ENTRY_KEYS = ["id", "kind", "title", "text", "source", "actions", "at", "count", "read"];

/** Returns the entries of a stored document, [] for a missing file; refuses a document of another format with the name of the file. */
export function checkNoticesDocument(document) {
  if (document === null || document === undefined) return [];
  if (typeof document !== "object" || document.format !== FORMAT || !Array.isArray(document.notices)) {
    throw new Error(`${NOTICES_FILE} holds no notices of format ${FORMAT}: ${JSON.stringify(document)}`);
  }
  for (const entry of document.notices) {
    const missing = ENTRY_KEYS.find((key) => !(key in entry));
    if (missing !== undefined) throw new Error(`${NOTICES_FILE} holds an entry without ${missing}`);
    // A card entry keeps the title of its tab as the label, which the source chip shows (docs/spec/notifications.md#notice-center).
    if (entry.source?.kind === "card" && !(typeof entry.source.label === "string" && entry.source.label !== "")) {
      throw new Error(`${NOTICES_FILE}: notice ${entry.id} is a card notice without its tab label`);
    }
  }
  return document.notices;
}

/**
 * Reads the notice center at start and writes it after each change. host has notices() and noticesPut(notices) of the workspace bridge;
 * failed(error) shows a failed read or write through the error display. No timer runs: the expired entries are dropped on read, write
 * and when the center opens (the store drops them on each read of its entries).
 */
export async function openNotices({ host, failed }) {
  const store = notificationStore();
  try {
    store.restore(checkNoticesDocument(await host.notices()));
  } catch (error) {
    failed(error);
    return () => {};
  }
  // The baseline is the state just read, so the first report writes only a change of the restored notices.
  let last = JSON.stringify(store.persistable());
  // The writes run one at a time: a write starts at once when none is in flight, and a change during a write waits in the queue.
  const queue = [];
  let busy = false;
  // Set while a refusal is shown: the error notice that the refusal adds is not a change of the notices, so it starts no write.
  let refusing = false;
  const refuse = (error) => {
    refusing = true;
    try {
      failed(error);
    } finally {
      refusing = false;
    }
    last = JSON.stringify(store.persistable());
  };
  const pump = () => {
    if (busy || queue.length === 0) return;
    busy = true;
    const text = queue.shift();
    let sent;
    try {
      sent = Promise.resolve(host.noticesPut(JSON.parse(text)));
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent
      .then(undefined, refuse)
      .finally(() => {
        busy = false;
        pump();
      });
  };
  // A writer of an earlier open ends here, so one change of the notices is written once.
  endNoticesWriter();
  // The returned function removes the listener; a later open of the file ends it (endNoticesWriter).
  stopWriter = onTabReports(() => {
    if (refusing) return;
    const text = JSON.stringify(store.persistable());
    if (text === last) return;
    last = text;
    queue.push(text);
    pump();
  });
  return endNoticesWriter;
}
